/**
 * Portable Telebirr (Fabric gateway) client.
 *
 * Dependencies: node:crypto, node:https, node:http, node:url only.
 * Drop into any Node project, wire up `TelebirrConfig`, and use.
 *
 * Distilled from a production integration. See SKILL.md for the reasoning
 * behind each rule; the comments here mark the parts that silently break.
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface TelebirrConfig {
  /** e.g. https://developerportal.ethiotelebirr.et:38443/apiaccess/payment/gateway */
  baseUrl: string;
  /** Fabric gateway app id -> X-APP-Key header. NOT the merchant app id. */
  fabricAppId: string;
  appSecret: string;
  /** Merchant app id -> biz_content.appid. NOT the fabric app id. */
  merchantAppId: string;
  merchantCode: string;
  /** Your PKCS8 private key. Bare base64 or full PEM. */
  privateKey: string;
  /** Telebirr's public key, for verifying callbacks. Bare base64 or full PEM. */
  publicKey?: string;
  notifyUrl: string;
  redirectUrl: string;
  timeoutMs?: number;
  /**
   * Mini App (InApp) payee routing. `payee_identifier` is not configurable: it
   * always mirrors `merchantCode`, which is what the gateway expects.
   */
  payeeType?: string;
  payeeIdentifierType?: string;
  /** Leave true unless the gateway chain genuinely fails to validate. */
  sslVerify?: boolean;
  /** Optional hook for append-only audit logging. */
  log?: (channel: string, context?: unknown) => void | Promise<void>;
}

export type SignMode = "pss_digest" | "pss_max" | "pkcs1";

/** Excluded from the canonical string entirely. */
const EXCLUDED_FIELDS = new Set([
  "sign",
  "sign_type",
  "header",
  "refund_info",
  "openType",
  "raw_request",
  "wallet_reference_data",
]);

const SUCCESS_STATUSES = ["PAY_SUCCESS", "Completed"];

// ---------------------------------------------------------------------------
// Canonicalisation + signing
// ---------------------------------------------------------------------------

/**
 * Build the string that gets signed.
 *
 * Rules, all load-bearing:
 *  1. flatten biz_content one level
 *  2. drop undefined / null / "" values
 *  3. drop EXCLUDED_FIELDS
 *  4. sort keys ASCII-ascending
 *  5. join key=value with &
 *  6. NO url encoding
 */
export function canonicalize(payload: Record<string, unknown>): string {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "" || EXCLUDED_FIELDS.has(key)) {
      continue;
    }

    if (key === "biz_content" && typeof value === "object") {
      for (const [bizKey, bizValue] of Object.entries(value as Record<string, unknown>)) {
        if (bizValue !== undefined && bizValue !== null && bizValue !== "") {
          flattened[bizKey] = String(bizValue);
        }
      }
      continue;
    }

    flattened[key] = String(value);
  }

  return Object.keys(flattened)
    .sort()
    .map((key) => `${key}=${flattened[key]}`)
    .join("&");
}

/** Keys often arrive as bare base64 with no PEM armour. */
function normalizeKey(raw: string, label: "PRIVATE" | "PUBLIC"): string {
  const normalized = raw.replace(/\r\n|\r|\\n/g, "\n").trim();
  if (normalized.includes("BEGIN")) {
    return `${normalized}\n`;
  }

  return [
    `-----BEGIN ${label} KEY-----`,
    normalized.match(/.{1,64}/g)?.join("\n") ?? normalized,
    `-----END ${label} KEY-----`,
    "",
  ].join("\n");
}

export function signPayload(
  payload: Record<string, unknown>,
  privateKey: string,
  mode: SignMode = "pss_digest",
): string {
  const data = Buffer.from(canonicalize(payload), "utf8");
  const key = normalizeKey(privateKey, "PRIVATE");

  const options =
    mode === "pkcs1"
      ? { key, padding: crypto.constants.RSA_PKCS1_PADDING }
      : {
          key,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength:
            mode === "pss_digest"
              ? crypto.constants.RSA_PSS_SALTLEN_DIGEST
              : crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN,
        };

  return crypto.sign("sha256", data, options).toString("base64");
}

/** `true` only when the signature is present, the key is configured, and it verifies. */
export function verifySignature(
  payload: Record<string, unknown>,
  publicKey: string | undefined,
): { verified: boolean; attempted: boolean; reason: string | null } {
  const signature = String(payload.sign ?? "").trim();
  if (!signature) {
    return { verified: false, attempted: false, reason: "missing_sign" };
  }
  if (!publicKey?.trim()) {
    return { verified: false, attempted: false, reason: "missing_public_key" };
  }

  try {
    const data = Buffer.from(canonicalize(payload), "utf8");
    const key = normalizeKey(publicKey, "PUBLIC");
    const signatureBytes = Buffer.from(signature, "base64");

    // Verification must accept every padding the signing ladder can produce,
    // otherwise a PSS-signed callback is rejected as forged.
    const paddings = [
      { padding: crypto.constants.RSA_PKCS1_PADDING },
      {
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      {
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO,
      },
    ];

    for (const options of paddings) {
      if (crypto.verify("sha256", data, { key, ...options }, signatureBytes)) {
        return { verified: true, attempted: true, reason: null };
      }
    }

    return { verified: false, attempted: true, reason: "signature_mismatch" };
  } catch (error) {
    return {
      verified: false,
      attempted: true,
      reason: error instanceof Error ? error.message : "verify_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unix SECONDS as a string. Not milliseconds, not ISO. */
export const timestamp = (): string => String(Math.floor(Date.now() / 1000));

/** 32 uppercase hex chars. */
export const nonce = (): string =>
  crypto.randomBytes(16).toString("hex").toUpperCase();

/**
 * Unique per attempt, and accepted by the gateway's validator.
 *
 * The gateway rejects anything outside an alphanumeric pattern with
 * "merch_order_id type mismatch", so every separator is stripped and the whole
 * value is kept within 32 characters. The timestamp is preserved intact for
 * uniqueness across retries; the order id is truncated from the left if needed.
 *
 * This is NOT reliably parseable back to your internal id any more. Map a
 * callback home with `callback_info` (primary) or by looking up the stored
 * merch_order_id (fallback).
 */
export const MERCH_ORDER_ID_MAX = 32;

export const createMerchantOrderId = (orderId: string | number): string => {
  const ts = timestamp();
  const clean = String(orderId).replace(/[^A-Za-z0-9]/g, "");
  const room = MERCH_ORDER_ID_MAX - ts.length - 1; // 1 for the "T" separator
  return `${clean.slice(-room)}T${ts}`;
};

/** Recover your internal id from a callback. Prefers callback_info. */
export function extractOrderId(payload: Record<string, unknown>): string | null {
  const callbackInfo = String(payload.callback_info ?? "").trim();
  if (callbackInfo) {
    return callbackInfo;
  }

  const match = /^ORD(.+)T\d+$/.exec(String(payload.merch_order_id ?? ""));
  return match ? match[1] : null;
}

/** Flatten biz_content into the top level, as signing expects. */
export function normalizePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...payload };
  const bizContent = normalized.biz_content;
  if (bizContent && typeof bizContent === "object" && !Array.isArray(bizContent)) {
    Object.assign(normalized, bizContent as Record<string, unknown>);
    delete normalized.biz_content;
  }

  return normalized;
}

export const isSuccessfulStatus = (status: string): boolean =>
  SUCCESS_STATUSES.includes(status.trim());

export const extractStatus = (payload: Record<string, unknown>): string =>
  String(payload.trade_status ?? payload.order_status ?? "").trim();

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  config: TelebirrConfig,
): Promise<T> {
  const payload = JSON.stringify(body);
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  const timeoutMs = config.timeoutMs ?? 30_000;

  return new Promise<T>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
          ...headers,
        },
        timeout: timeoutMs,
        // Scoped to this client only - never disable TLS checks globally.
        ...(isHttps ? { rejectUnauthorized: config.sslVerify !== false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            // Keep the raw text: the gateway hides error codes in the body.
            reject(new Error(`Telebirr ${status}: ${text.slice(0, 400) || "<empty>"}`));
            return;
          }

          try {
            resolve(text ? (JSON.parse(text) as T) : ({} as T));
          } catch {
            reject(new Error(`Telebirr non-JSON response: ${text.slice(0, 400)}`));
          }
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error(`Telebirr timeout after ${timeoutMs}ms`)));
    req.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      reject(new Error(`Telebirr network error: ${err.message} (code=${err.code ?? "UNKNOWN"})`));
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CheckoutResult {
  checkoutUrl: string;
  merchantOrderId: string;
  prepayId: string;
}

export class TelebirrClient {
  /** Whichever padding the gateway accepted; reused for later calls. */
  private signMode: SignMode = "pss_digest";

  constructor(private readonly config: TelebirrConfig) {}

  private get apiBase(): string {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  private async log(channel: string, context?: unknown): Promise<void> {
    await this.config.log?.(channel, context);
  }

  private isSignatureError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("60200099") || message.includes("Verify the sign field failed");
  }

  private sign(payload: Record<string, unknown>, mode = this.signMode): string {
    return signPayload(payload, this.config.privateKey, mode);
  }

  /** Short-lived. Fetched per operation rather than cached. */
  async applyFabricToken(): Promise<string> {
    const response = await postJson<{ token?: string }>(
      `${this.apiBase}/payment/v1/token`,
      { appSecret: this.config.appSecret },
      { "X-APP-Key": this.config.fabricAppId },
      this.config,
    );

    if (!response.token) {
      await this.log("token_failed", response);
      throw new Error("Telebirr token request failed.");
    }

    return response.token;
  }

  /**
   * Send a signed request, walking the padding ladder on 60200099 only.
   * Other errors propagate immediately so real bugs are not masked.
   */
  private async sendSigned<T>(
    path: string,
    request: Record<string, unknown>,
    token: string,
  ): Promise<T> {
    const modes: SignMode[] = [this.signMode, "pss_max", "pkcs1", "pss_digest"].filter(
      (mode, index, all) => all.indexOf(mode) === index,
    ) as SignMode[];

    let lastError: unknown;

    for (const mode of modes) {
      request.sign = this.sign(request, mode);
      request.sign_type = "SHA256WithRSA";

      // Record the exact signed body before it goes out. This is what Telebirr
      // support asks for when a request is rejected, and it cannot be
      // reconstructed afterwards because nonce_str and timestamp change.
      await this.log("request_sent", {
        url: `${this.apiBase}${path}`,
        signMode: mode,
        canonicalString: canonicalize(request),
        request,
      });

      try {
        const response = await postJson<T>(
          `${this.apiBase}${path}`,
          request,
          { Authorization: token, "X-APP-Key": this.config.fabricAppId },
          this.config,
        );
        this.signMode = mode;
        await this.log("request_ok", { url: `${this.apiBase}${path}`, response });
        return response;
      } catch (error) {
        lastError = error;
        await this.log("sign_attempt_failed", { mode, error: String(error) });
        if (!this.isSignatureError(error)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Telebirr signing failed.");
  }

  /** Phase 2 + 3: preOrder then the signed checkout URL. */
  async createCheckout(params: {
    orderId: string | number;
    /** Numeric amount; formatted to 2dp internally. */
    amount: number;
    title: string;
    /** Defaults to orderId. Round-trips back in the callback. */
    callbackInfo?: string;
    /** Per-order landing page. Cosmetic only - never a fulfilment signal. */
    redirectUrl?: string;
  }): Promise<CheckoutResult> {
    const token = await this.applyFabricToken();
    const merchantOrderId = createMerchantOrderId(params.orderId);

    const request: Record<string, unknown> = {
      timestamp: timestamp(),
      nonce_str: nonce(),
      method: "payment.preorder",
      version: "1.0",
      biz_content: {
        notify_url: this.config.notifyUrl,
        redirect_url: params.redirectUrl ?? this.config.redirectUrl,
        appid: this.config.merchantAppId,
        merch_code: this.config.merchantCode,
        merch_order_id: merchantOrderId,
        trade_type: "Checkout",
        title: params.title.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 120),
        total_amount: params.amount.toFixed(2), // string, exactly 2 decimals
        trans_currency: "ETB",
        timeout_express: "120m",
        business_type: "BuyGoods",
        callback_info: String(params.callbackInfo ?? params.orderId),
      },
    };

    const response = await this.sendSigned<{
      result?: string;
      code?: string;
      msg?: string;
      biz_content?: { prepay_id?: string };
    }>("/payment/v1/merchant/preOrder", request, token);

    const prepayId = response.biz_content?.prepay_id;
    // HTTP 200 is not success. All three must hold.
    if (response.result !== "SUCCESS" || response.code !== "0" || !prepayId) {
      await this.log("preorder_failed", response);
      throw new Error(response.msg || "Telebirr preorder failed.");
    }

    return {
      checkoutUrl: this.buildCheckoutUrl(prepayId),
      merchantOrderId,
      prepayId,
    };
  }

  /** Sign exactly five params; append version/trade_type AFTER signing. */
  private buildCheckoutUrl(prepayId: string): string {
    const paramsToSign: Record<string, string> = {
      appid: this.config.merchantAppId,
      merch_code: this.config.merchantCode,
      nonce_str: nonce(),
      prepay_id: prepayId,
      timestamp: timestamp(),
    };

    const url = new URL(
      this.config.baseUrl.includes("/apiaccess/payment/gateway")
        ? this.config.baseUrl.replace("/apiaccess/payment/gateway", "/payment/web/paygate")
        : `${this.apiBase}/payment/web/paygate`,
    );

    for (const [key, value] of Object.entries(paramsToSign)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("version", "1.0");
    url.searchParams.set("trade_type", "Checkout");
    url.searchParams.set("sign", this.sign(paramsToSign));
    url.searchParams.set("sign_type", "SHA256WithRSA");

    return url.toString();
  }

  /** The authoritative "was this paid?". Rate-limited, so backs off. */
  async queryOrder(merchantOrderId: string): Promise<Record<string, unknown>> {
    const delays = [0, 1_000, 3_000];

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }

      try {
        const token = await this.applyFabricToken();
        return await this.sendSigned<Record<string, unknown>>(
          "/payment/v1/merchant/queryOrder",
          {
            timestamp: timestamp(),
            nonce_str: nonce(),
            method: "payment.queryorder",
            version: "1.0",
            biz_content: {
              appid: this.config.merchantAppId,
              merch_code: this.config.merchantCode,
              merch_order_id: merchantOrderId,
            },
          },
          token,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const quotaRejected =
          message.includes("49401021002") || message.includes("quotaControl");
        if (!quotaRejected || attempt === delays.length - 1) {
          throw error;
        }
      }
    }

    throw new Error("Telebirr queryOrder failed after retries.");
  }

  isSuccessfulQuery(response: Record<string, unknown>): boolean {
    if (!response || Object.keys(response).length === 0) return false;
    if (String(response.result ?? "") !== "SUCCESS") return false;
    if (String(response.code ?? "") !== "0") return false;

    const biz = (response.biz_content ?? {}) as Record<string, unknown>;
    return isSuccessfulStatus(extractStatus(biz));
  }

  /**
   * Decide whether a callback represents a real payment.
   *
   * Trusts the notify body ONLY when its signature verifies AND the status is
   * successful. Otherwise asks the gateway directly. Missing/incorrect public
   * key therefore degrades to "always query" - slower, still safe.
   */
  async confirmPayment(rawPayload: Record<string, unknown>): Promise<{
    paid: boolean;
    orderId: string | null;
    transactionId: string;
    amount: string;
    merchantOrderId: string;
    via: "notify" | "query";
  }> {
    const payload = normalizePayload(rawPayload);
    const merchantOrderId = String(payload.merch_order_id ?? "").trim();
    if (!merchantOrderId) {
      throw new Error("Missing merch_order_id in notify payload.");
    }

    const signature = verifySignature(payload, this.config.publicKey);
    const notifyStatus = extractStatus(payload);
    const trustedNotify = signature.verified && isSuccessfulStatus(notifyStatus);

    let queryBiz: Record<string, unknown> = {};
    let paid = trustedNotify;

    if (!trustedNotify) {
      await this.log("notify_untrusted_querying", {
        merchantOrderId,
        notifyStatus,
        signature,
      });
      const queryResponse = await this.queryOrder(merchantOrderId);
      queryBiz = (queryResponse.biz_content ?? {}) as Record<string, unknown>;
      paid = this.isSuccessfulQuery(queryResponse);
    }

    return {
      paid,
      orderId: extractOrderId(payload),
      transactionId: String(
        payload.trans_id ??
          payload.transId ??
          queryBiz.trans_id ??
          payload.payment_order_id ??
          queryBiz.payment_order_id ??
          merchantOrderId,
      ),
      amount: String(payload.total_amount ?? queryBiz.total_amount ?? "0"),
      merchantOrderId,
      via: trustedNotify ? "notify" : "query",
    };
  }

  // -------------------------------------------------------------------------
  // Mini App (InApp) mode
  //
  // Same token, signing and notify machinery as Checkout mode. Two differences:
  // trade_type is "InApp" with payee routing fields, and instead of a redirect
  // URL the SuperApp is handed a `rawRequest` string for its payment JS bridge.
  // -------------------------------------------------------------------------

  /**
   * Exchange the SuperApp `access_token` for the user's identity.
   *
   * Only works for a request originating inside the SuperApp, since that is
   * where the access token comes from.
   */
  async authToken(appToken: string): Promise<Record<string, unknown>> {
    const token = await this.applyFabricToken();

    return this.sendSigned<Record<string, unknown>>(
      "/payment/v1/auth/authToken",
      {
        timestamp: timestamp(),
        nonce_str: nonce(),
        method: "payment.authtoken",
        version: "1.0",
        biz_content: {
          access_token: appToken,
          trade_type: "InApp",
          appid: this.config.merchantAppId,
          resource_type: "OpenId",
        },
      },
      token,
    );
  }

  /** preOrder in InApp mode, returning the rawRequest the JS bridge expects. */
  async createInAppOrder(params: {
    orderId: string | number;
    amount: number;
    title: string;
    callbackInfo?: string;
  }): Promise<{ rawRequest: string; merchantOrderId: string; prepayId: string }> {
    const token = await this.applyFabricToken();
    const merchantOrderId = createMerchantOrderId(params.orderId);

    const request: Record<string, unknown> = {
      timestamp: timestamp(),
      nonce_str: nonce(),
      method: "payment.preorder",
      version: "1.0",
      biz_content: {
        notify_url: this.config.notifyUrl,
        business_type: "BuyGoods",
        trade_type: "InApp",
        appid: this.config.merchantAppId,
        merch_code: this.config.merchantCode,
        merch_order_id: merchantOrderId,
        title: params.title.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 120),
        total_amount: params.amount.toFixed(2),
        trans_currency: "ETB",
        timeout_express: "120m",
        // payee_identifier is the merchant code, same value as merch_code.
        payee_identifier: this.config.merchantCode,
        payee_identifier_type: this.config.payeeIdentifierType ?? "04",
        payee_type: this.config.payeeType ?? "5000",
        callback_info: String(params.callbackInfo ?? params.orderId),
      },
    };

    const response = await this.sendSigned<{
      result?: string;
      code?: string;
      msg?: string;
      biz_content?: { prepay_id?: string };
    }>("/payment/v1/merchant/preOrder", request, token);

    const prepayId = response.biz_content?.prepay_id;
    if (response.result !== "SUCCESS" || response.code !== "0" || !prepayId) {
      await this.log("inapp_preorder_failed", response);
      throw new Error(response.msg || "Telebirr InApp preorder failed.");
    }

    return { rawRequest: this.buildRawRequest(prepayId), merchantOrderId, prepayId };
  }

  /**
   * The `rawRequest` query string handed to `js_fun_start_pay`.
   *
   * Unlike the Checkout URL this carries `sign_type` inside the string, and no
   * `version` or `trade_type`. Canonicalisation still drops `sign_type` before
   * signing, so the signature covers the same five params either way.
   */
  private buildRawRequest(prepayId: string): string {
    const maps: Record<string, string> = {
      appid: this.config.merchantAppId,
      merch_code: this.config.merchantCode,
      nonce_str: nonce(),
      prepay_id: prepayId,
      timestamp: timestamp(),
      sign_type: "SHA256WithRSA",
    };

    const pairs = Object.entries(maps).map(([key, value]) => `${key}=${value}`);
    return `${pairs.join("&")}&sign=${this.sign(maps)}`;
  }
}
