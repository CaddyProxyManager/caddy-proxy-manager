import { type CaptchaWidgetConfig, capSiteUrl } from "./providers";

const SITEVERIFY: Record<Exclude<CaptchaWidgetConfig["provider"], "cap">, string> = {
  recaptcha: "https://www.google.com/recaptcha/api/siteverify",
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
};

const TIMEOUT_MS = 10_000;

/** "unavailable" is the service not answering, worded differently from a failed solve. */
export type CaptchaVerdict = "passed" | "failed" | "unavailable";

export type CaptchaCheck = {
  provider: CaptchaWidgetConfig["provider"];
  siteKey: string;
  secret: string;
  /** Cap only. */
  capInstanceUrl?: string;
};

/** Tokens are single-use at the provider too. */
export async function verifyCaptchaToken(
  check: CaptchaCheck,
  token: string,
  remoteIp: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptchaVerdict> {
  if (!token || token.length > 8192) return "failed";

  let request: { url: string; init: RequestInit };
  if (check.provider === "cap") {
    if (!check.capInstanceUrl) return "unavailable";
    request = {
      url: `${capSiteUrl(check.capInstanceUrl, check.siteKey)}siteverify`,
      init: {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: check.secret, response: token }),
      },
    };
  } else {
    const form = new URLSearchParams({ secret: check.secret, response: token });
    if (remoteIp) form.set("remoteip", remoteIp);
    // hCaptcha refuses a token solved for another site key only when told which one to expect.
    if (check.provider === "hcaptcha") form.set("sitekey", check.siteKey);
    request = { url: SITEVERIFY[check.provider], init: { body: form } };
  }

  try {
    const response = await fetchImpl(request.url, {
      ...request.init,
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[captcha] ${check.provider} siteverify answered ${response.status}`);
      return "unavailable";
    }
    const body = (await response.json()) as { success?: unknown; "error-codes"?: unknown };
    if (body.success === true) return "passed";
    // A wrong secret looks like every visitor failing the puzzle, so it is the operator's to fix.
    const codes = Array.isArray(body["error-codes"]) ? body["error-codes"].map(String) : [];
    if (codes.some((code) => /secret/i.test(code))) {
      console.warn(`[captcha] ${check.provider} rejected the secret key: ${codes.join(", ")}`);
      return "unavailable";
    }
    return "failed";
  } catch (error) {
    console.warn(`[captcha] ${check.provider} siteverify failed:`, error);
    return "unavailable";
  }
}
