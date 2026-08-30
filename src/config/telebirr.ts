import dotenv from 'dotenv';
import type { TelebirrConfig } from '../services/telebirr/client';

dotenv.config();

/**
 * Telebirr Fabric gateway configuration.
 *
 * `TELE_FABRIC_APP_ID` and `TELE_MERCHANT_APP_ID` are DIFFERENT values and are
 * the most common mix-up: the fabric id goes in the X-APP-Key header, the
 * merchant app id goes in biz_content.appid.
 */

const REQUIRED_VARS = [
  'TELE_BASE_URL',
  'TELE_FABRIC_APP_ID',
  'TELE_APP_SECRET',
  'TELE_MERCHANT_APP_ID',
  'TELE_MERCHANT_CODE',
  'TELE_PRIVATE_KEY',
  'TELE_NOTIFY_URL',
  'TELE_REDIRECT_URL',
] as const;

export const telebirrEnabled = (): boolean =>
  REQUIRED_VARS.every((name) => Boolean(process.env[name]?.trim()));

/**
 * Reads and validates the Telebirr environment.
 *
 * Throws listing every missing variable at once - a missing key otherwise
 * surfaces as an opaque signature error three API calls later.
 */
export function loadTelebirrConfig(): TelebirrConfig {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]?.trim());

  if (missing.length > 0) {
    throw new Error(
      `Telebirr is not configured. Missing environment variable(s): ${missing.join(', ')}. ` +
        `Set them in .env (see .env.example) or leave them all unset to run in sandbox mode.`
    );
  }

  if (!process.env.TELE_PUBLIC_KEY?.trim()) {
    // Not fatal: every callback then falls through to queryOrder, which is
    // slower but still safe. Loud, because it is almost never intentional.
    console.warn(
      '[telebirr] TELE_PUBLIC_KEY is not set - notify signatures cannot be verified. ' +
        'Every callback will be confirmed via queryOrder instead (slower, still safe).'
    );
  }

  const notifyUrl = process.env.TELE_NOTIFY_URL!.trim();
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(notifyUrl)) {
    console.warn(
      `[telebirr] TELE_NOTIFY_URL points at localhost (${notifyUrl}). Telebirr cannot reach it ` +
        'and no payment will ever be confirmed. Use a public HTTPS tunnel (e.g. ngrok) in development.'
    );
  }

  return {
    baseUrl: process.env.TELE_BASE_URL!.trim(),
    fabricAppId: process.env.TELE_FABRIC_APP_ID!.trim(),
    appSecret: process.env.TELE_APP_SECRET!.trim(),
    merchantAppId: process.env.TELE_MERCHANT_APP_ID!.trim(),
    merchantCode: process.env.TELE_MERCHANT_CODE!.trim(),
    privateKey: process.env.TELE_PRIVATE_KEY!.trim(),
    publicKey: process.env.TELE_PUBLIC_KEY?.trim(),
    notifyUrl,
    redirectUrl: process.env.TELE_REDIRECT_URL!.trim(),
    timeoutMs: parseInt(process.env.TELE_TIMEOUT_MS || '30000', 10),
    sslVerify: process.env.TELE_SSL_VERIFY !== 'false',
    // Mini App (InApp) payee routing. payee_identifier is deliberately absent:
    // it always mirrors the merchant code, set in the client.
    payeeType: process.env.TELE_PAYEE_TYPE || '5000',
    payeeIdentifierType: process.env.TELE_PAYEE_IDENTIFIER_TYPE || '04',
  };
}

/** Sandbox shortcuts (mock pay page, instant-checkout button) are dev-only. */
export const sandboxPaymentsAllowed = (): boolean =>
  process.env.NODE_ENV !== 'production' && process.env.TELE_ALLOW_SANDBOX_PAY === 'true';
