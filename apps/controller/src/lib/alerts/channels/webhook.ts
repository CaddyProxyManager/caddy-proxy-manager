/**
 * A generic webhook, signed per the Standard Webhooks scheme: `webhook-id`, `webhook-timestamp`
 * (unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256>` over `id.timestamp.body`, with
 * the key the base64 after `whsec_`. The timestamp is inside the MAC, so a stock verifier refuses
 * a stale or altered one; the id stays the same across retries, so a receiver can drop a replay.
 */

import { createHash, randomBytes } from "node:crypto";
import type { AlertBatch } from "../message";

export const SECRET_PREFIX = "whsec_";
/** Header names a custom header may not take: the signature's and the body's own. */
export const RESERVED_HEADERS = new Set([
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "content-type",
  "content-length",
  "host",
  "transfer-encoding",
]);

export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

/** The key bytes, or null for a secret that is not `whsec_` and at least 24 bytes of base64. */
export function signingKey(secret: string): Uint8Array | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length >= 24 ? new Uint8Array(key) : null;
}

export function sign(key: Uint8Array, id: string, timestamp: number, body: string): string {
  // A CryptoHasher cannot be reused after digest(), so one per signature.
  const hmac = new Bun.CryptoHasher("sha256", key);
  hmac.update(`${id}.${timestamp}.${body}`);
  return `v1,${hmac.digest("base64")}`;
}

/** Stable for the same deliveries, so a retry carries the id the first try did. */
export function messageId(deliveryIds: readonly number[]): string {
  const digest = createHash("sha256")
    .update([...deliveryIds].sort((a, b) => a - b).join(","))
    .digest("hex");
  return `msg_${digest.slice(0, 32)}`;
}

export type WebhookBody = {
  type: "alerts" | "digest";
  timestamp: string;
  data: {
    subject: string;
    url: string;
    alerts: {
      id: number;
      kind: string;
      severity: string;
      resolved: boolean;
      title: string;
      text: string;
      at: string;
      rule: string | null;
      event: unknown;
    }[];
  };
};

export function webhookBody(batch: AlertBatch, now: number): WebhookBody {
  return {
    type: batch.type ?? "alerts",
    timestamp: new Date(now).toISOString(),
    data: {
      subject: batch.subject,
      url: batch.url,
      alerts: batch.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        severity: item.severity,
        resolved: item.resolved,
        title: item.title,
        text: item.text,
        at: item.at,
        rule: item.rule,
        event: item.event,
      })),
    },
  };
}

export function signedHeaders(
  key: Uint8Array,
  id: string,
  now: number,
  body: string,
  custom: readonly { name: string; value: string }[],
): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  const headers: Record<string, string> = {};
  for (const { name, value } of custom) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  return {
    ...headers,
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": sign(key, id, timestamp, body),
  };
}
