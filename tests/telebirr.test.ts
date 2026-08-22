import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  canonicalize,
  signPayload,
  verifySignature,
  extractOrderId,
  normalizePayload,
  isSuccessfulStatus,
} from '../src/services/telebirr/client';
import { parseNotifyBody } from '../src/controllers/telebirrController';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Telebirr canonicalisation', () => {
  it('flattens biz_content, drops empties and excluded fields, and sorts keys', () => {
    const canonical = canonicalize({
      timestamp: '1735689600',
      nonce_str: 'ABC',
      sign: 'should-be-dropped',
      sign_type: 'SHA256WithRSA',
      header: { ignored: true },
      empty: '',
      missing: null,
      biz_content: {
        merch_code: '611276',
        appid: '1599397665510408',
        total_amount: '25.00',
        blank: '',
      },
    });

    expect(canonical).toBe(
      'appid=1599397665510408&merch_code=611276&nonce_str=ABC&timestamp=1735689600&total_amount=25.00'
    );
  });

  it('does not URL-encode values', () => {
    const canonical = canonicalize({
      notify_url: 'https://host/api/webhooks/telebirr?a=b',
    });
    expect(canonical).toBe('notify_url=https://host/api/webhooks/telebirr?a=b');
  });
});

describe('Telebirr signing', () => {
  // The signing ladder can emit PSS or PKCS#1; verification must accept both,
  // or a genuine callback is silently rejected as forged.
  it.each(['pss_digest', 'pss_max', 'pkcs1'] as const)('verifies a %s signature', (mode) => {
    const payload: Record<string, unknown> = { merch_order_id: 'ORD1T2', total_amount: '25.00' };
    payload.sign = signPayload(payload, privateKey, mode);

    expect(verifySignature(payload, publicKey).verified).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const payload: Record<string, unknown> = { merch_order_id: 'ORD1T2', total_amount: '25.00' };
    payload.sign = signPayload(payload, privateKey);
    payload.total_amount = '1.00';

    expect(verifySignature(payload, publicKey).verified).toBe(false);
  });

  it('reports missing key without claiming verification succeeded', () => {
    const result = verifySignature({ sign: 'x' }, undefined);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('missing_public_key');
  });

  it('accepts bare base64 keys without PEM armour', () => {
    const bare = publicKey
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
      .replace(/\s/g, '');
    const payload: Record<string, unknown> = { merch_order_id: 'ORD1T2' };
    payload.sign = signPayload(payload, privateKey);

    expect(verifySignature(payload, bare).verified).toBe(true);
  });
});

describe('Telebirr notify body parsing', () => {
  it('parses application/json', () => {
    expect(parseNotifyBody('{"a":"1"}', 'application/json')).toEqual({ a: '1' });
  });

  it('parses form-encoded bodies', () => {
    expect(
      parseNotifyBody('a=1&b=2', 'application/x-www-form-urlencoded')
    ).toEqual({ a: '1', b: '2' });
  });

  it('parses the whole JSON document arriving as a single empty-valued form key', () => {
    const json = JSON.stringify({ merch_order_id: 'ORD5T9', trade_status: 'PAY_SUCCESS' });
    const body = `${encodeURIComponent(json)}=`;

    expect(parseNotifyBody(body, 'application/x-www-form-urlencoded')).toEqual({
      merch_order_id: 'ORD5T9',
      trade_status: 'PAY_SUCCESS',
    });
  });

  it('returns an empty object for a blank body', () => {
    expect(parseNotifyBody('   ', undefined)).toEqual({});
  });
});

describe('Telebirr callback mapping', () => {
  it('prefers callback_info when recovering our order number', () => {
    expect(
      extractOrderId({ callback_info: 'ORD-123-4567', merch_order_id: 'ORDsomethingelseT99' })
    ).toBe('ORD-123-4567');
  });

  it('falls back to parsing merch_order_id', () => {
    expect(extractOrderId({ merch_order_id: 'ORDORD-123-4567T1735689600' })).toBe('ORD-123-4567');
  });

  it('returns null when neither is present', () => {
    expect(extractOrderId({})).toBeNull();
  });

  it('flattens biz_content onto the top level', () => {
    expect(normalizePayload({ a: '1', biz_content: { b: '2' } })).toEqual({ a: '1', b: '2' });
  });

  it('treats only PAY_SUCCESS and Completed as paid', () => {
    expect(isSuccessfulStatus('PAY_SUCCESS')).toBe(true);
    expect(isSuccessfulStatus('Completed')).toBe(true);
    expect(isSuccessfulStatus('PENDING')).toBe(false);
    expect(isSuccessfulStatus('PAY_FAILED')).toBe(false);
  });
});
