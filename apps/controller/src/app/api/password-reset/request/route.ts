/**
 * Asks for a reset link. Always the same answer, and before any mail is sent, so neither the body
 * nor the timing says whether the address has an account.
 */

import type { NextRequest } from "next/server";
import { getLocale } from "next-intl/server";
import { checkSameOrigin } from "@/src/lib/auth";
import { getClientIp } from "@/src/lib/client-ip";
import { takeFromWindow } from "@/src/lib/rate-limit";
import { requestPasswordReset } from "@/src/lib/services/password-links";

export const dynamic = "force-dynamic";

const WINDOW_MS = 60 * 60_000;
/** Per address: enough to retry a lost message, too few to fill someone's inbox. */
const PER_IDENTIFIER = 3;
const PER_CLIENT = 10;

export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  let body: { identifier?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ code: "BAD_REQUEST" }, { status: 400 });
  }
  const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  if (!identifier || identifier.length > 320) {
    return Response.json({ code: "BAD_REQUEST" }, { status: 400 });
  }

  const ip = await getClientIp(request.headers);
  if (!takeFromWindow(`password-reset:ip:${ip ?? "unknown"}`, PER_CLIENT, WINDOW_MS)) {
    return Response.json({ code: "TOO_MANY_REQUESTS" }, { status: 429 });
  }
  // Counted but not reported: a 429 here would confirm the address is being asked about.
  if (takeFromWindow(`password-reset:id:${identifier.toLowerCase()}`, PER_IDENTIFIER, WINDOW_MS)) {
    const locale = await getLocale();
    void requestPasswordReset(identifier, locale).catch((error: unknown) => {
      console.error("[password-reset] Could not send a reset link:", error);
    });
  }

  return Response.json({ ok: true });
}
