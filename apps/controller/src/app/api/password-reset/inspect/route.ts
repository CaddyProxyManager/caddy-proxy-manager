/** Whether an emailed link still works, so the form can say so before a password is typed. */

import type { NextRequest } from "next/server";
import { checkSameOrigin } from "@/src/lib/auth";
import { getClientIp } from "@/src/lib/client-ip";
import { takeFromWindow } from "@/src/lib/rate-limit";
import { describeEmailedLink } from "@/src/lib/services/emailed-links";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  const ip = await getClientIp(request.headers);
  if (!takeFromWindow(`password-link:inspect:${ip ?? "unknown"}`, 30, 15 * 60_000)) {
    return Response.json({ code: "TOO_MANY_REQUESTS" }, { status: 429 });
  }

  let body: { token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ code: "BAD_REQUEST" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const link = token.length > 0 && token.length <= 128 ? await describeEmailedLink(token) : null;
  if (!link) return Response.json({ code: "INVALID_LINK" }, { status: 404 });
  return Response.json(link, { headers: { "Cache-Control": "no-store" } });
}
