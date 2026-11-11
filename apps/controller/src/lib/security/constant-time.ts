import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The one comparison for secrets and signatures. Both sides are hashed to a fixed width first:
 * `timingSafeEqual` throws on a length mismatch, which would leak the length and, for strings
 * whose UTF-8 width differs from their `.length`, crash the caller.
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = createHmac("sha256", "compare").update(a).digest();
  const right = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(left, right);
}
