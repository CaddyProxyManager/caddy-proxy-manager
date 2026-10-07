/**
 * One POST to a chat service or webhook, through the outbound client. A 429 with a short wait is
 * waited out and tried again here; a longer one goes back to the caller as the channel's retry.
 */

import { OutboundError, outboundFetch } from "../../http/outbound";
import { discordRetryAfterMs } from "./discord";

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; retryAfterMs: number | null };

/** Longer than this is not waited for inline: the channel backs off instead. */
export const INLINE_WAIT_MS = 10_000;
const INLINE_RETRIES = 2;
const TIMEOUT_MS = 15_000;

let sleep = (ms: number) => Bun.sleep(ms);

/** Test seam: what a 429 waits with. */
export function setSleepForTests(fake: ((ms: number) => Promise<void>) | null): void {
  sleep = fake ?? ((ms: number) => Bun.sleep(ms));
}

/** `Retry-After` in seconds or as a date; null when absent or unreadable. */
export function retryAfterHeaderMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function describe(error: unknown): string {
  if (error instanceof OutboundError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: { discord?: boolean } = {},
): Promise<SendResult> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      // outbound: alerts
      response = await outboundFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        timeoutMs: TIMEOUT_MS,
        maxResponseBytes: 64 * 1024,
      });
    } catch (error) {
      return { ok: false, status: null, error: describe(error), retryAfterMs: null };
    }
    if (response.ok) return { ok: true, status: response.status };
    const text = await response.text().catch(() => "");
    if (response.status === 429) {
      const wait =
        (options.discord ? discordRetryAfterMs(text) : null) ??
        retryAfterHeaderMs(response.headers.get("retry-after"));
      if (wait !== null && wait <= INLINE_WAIT_MS && attempt < INLINE_RETRIES) {
        await sleep(wait);
        continue;
      }
      return {
        ok: false,
        status: 429,
        error: `HTTP 429 ${text.trim().slice(0, 200)}`.trim(),
        retryAfterMs: wait,
      };
    }
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status} ${text.replace(/\s+/g, " ").trim().slice(0, 200)}`.trim(),
      retryAfterMs: null,
    };
  }
}
