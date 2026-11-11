import { timingSafeEqual } from "node:crypto";

/**
 * The one comparison for secrets and signatures. Every caller's expected value has a fixed,
 * public length, so a length mismatch may return early; it is checked in bytes, since
 * `timingSafeEqual` throws when a string's UTF-8 width differs from its `.length`.
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = typeof a === "string" ? Buffer.from(a, "utf8") : a;
  const right = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
