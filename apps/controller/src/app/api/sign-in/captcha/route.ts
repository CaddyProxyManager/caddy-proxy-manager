/**
 * Verifies a CAPTCHA token and sets the pass the password step requires (`lib/captcha/pass.ts`).
 * A route, not an action: the docs site renders `LoginClient` and cannot bundle the database.
 */

import { getClientIp } from "@/src/lib/http/client-ip";
import {
  CAPTCHA_PASS_COOKIE,
  CAPTCHA_PASS_PATH,
  CAPTCHA_PASS_TTL_MS,
  issueCaptchaPass,
} from "@/src/lib/captcha/pass";
import { activeCaptcha, captchaSecret, getCaptchaSettings } from "@/src/lib/captcha/settings";
import { verifyCaptchaToken } from "@/src/lib/captcha/verify";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";
import { takeFromWindow } from "@/src/lib/auth/rate-limit";

export const dynamic = "force-dynamic";

/** Each check is an outbound request to the provider, so one address may not drive many. */
const CHECKS_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60_000;

export async function POST(request: Request) {
  const settings = await getCaptchaSettings();
  const active = activeCaptcha(settings);
  if (!active) return Response.json({ code: "CAPTCHA_DISABLED" }, { status: 404 });

  const ip = await getClientIp(request.headers);
  if (!takeFromWindow(`captcha:${ip ?? "unknown"}`, CHECKS_PER_WINDOW, WINDOW_MS)) {
    return Response.json({ code: "TOO_MANY_REQUESTS" }, { status: 429 });
  }

  let body: { username?: unknown; token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ code: "CAPTCHA_FAILED" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const token = typeof body.token === "string" ? body.token : "";
  if (!username || username.length > 255) {
    return Response.json({ code: "CAPTCHA_FAILED" }, { status: 400 });
  }

  const verdict = await verifyCaptchaToken(
    {
      provider: active.provider,
      siteKey: settings.siteKey,
      secret: captchaSecret(settings),
      capInstanceUrl: settings.capInstanceUrl,
    },
    token,
    ip,
  );
  if (verdict === "unavailable") {
    return Response.json({ code: "CAPTCHA_UNAVAILABLE" }, { status: 503 });
  }
  if (verdict === "failed") return Response.json({ code: "CAPTCHA_FAILED" }, { status: 403 });

  // Secure on Better Auth's session cookie's terms, so the two travel together.
  const secure = (await getPublicBaseUrl()).toLowerCase().startsWith("https:");
  const cookie = [
    `${CAPTCHA_PASS_COOKIE}=${issueCaptchaPass(username)}`,
    `Path=${CAPTCHA_PASS_PATH}`,
    `Max-Age=${CAPTCHA_PASS_TTL_MS / 1000}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
