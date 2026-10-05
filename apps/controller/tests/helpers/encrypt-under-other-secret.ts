import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** A SESSION_SECRET other than the one the tests run with, as a rotation leaves behind. */
export const OTHER_SESSION_SECRET = 'a-previous-session-secret-that-is-long-enough';

function keyFor(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.alloc(0), 'caddy-proxy-manager:secret:v1', 32),
  );
}

/**
 * Encrypted the way src/lib/secrets/index.ts does it, under another secret: config memoises
 * SESSION_SECRET, so a test cannot switch it and encrypt.
 */
export function encryptUnderOtherSecret(value: string, secret = OTHER_SESSION_SECRET): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** The reverse, or null when `secret` does not open it: which key a stored value is under. */
export function decryptUnderSecret(value: string, secret: string): string | null {
  const [, , iv, tag, data] = value.split(':');
  if (!iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}
