import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** A SESSION_SECRET other than the one the tests run with, as a rotation leaves behind. */
export const OTHER_SESSION_SECRET = 'a-previous-session-secret-that-is-long-enough';

/**
 * Encrypted the way src/lib/secret.ts does it, under another secret: config memoises
 * SESSION_SECRET, so a test cannot switch it and encrypt.
 */
export function encryptUnderOtherSecret(value: string, secret = OTHER_SESSION_SECRET): string {
  const key = Buffer.from(
    hkdfSync('sha256', secret, Buffer.alloc(0), 'caddy-proxy-manager:secret:v1', 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}
