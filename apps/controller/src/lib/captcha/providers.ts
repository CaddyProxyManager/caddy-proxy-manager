/**
 * CAPTCHA services for the sign-in screen. Client-safe: the login form, CSP builder and settings
 * form read this, so nothing here may reach the database or a secret.
 */

export const CAPTCHA_PROVIDERS = ["recaptcha", "hcaptcha", "turnstile", "cap"] as const;

export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];

export function isCaptchaProvider(value: unknown): value is CaptchaProvider {
  return typeof value === "string" && (CAPTCHA_PROVIDERS as readonly string[]).includes(value);
}

/** What the login page needs to draw the widget. Never carries the secret. */
export type CaptchaWidgetConfig = {
  provider: CaptchaProvider;
  siteKey: string;
  /** Cap only: the instance the widget fetches its challenges from, site key included. */
  capApiEndpoint?: string;
};

/** Pinned, not `@latest`: an unreviewed release would run on the sign-in page. */
export const CAP_WIDGET_VERSION = "0.1.58";

/** Cap Standalone serves each site key under its own path, widget and siteverify alike. */
export function capSiteUrl(instanceUrl: string, siteKey: string): string {
  return `${instanceUrl.replace(/\/+$/, "")}/${encodeURIComponent(siteKey)}/`;
}

/** Explicit rendering, so React decides when the widget mounts. */
export function captchaScriptUrl(provider: CaptchaProvider, locale?: string): string {
  const hl = locale ? `&hl=${encodeURIComponent(locale)}` : "";
  switch (provider) {
    case "recaptcha":
      return `https://www.google.com/recaptcha/api.js?render=explicit${hl}`;
    case "hcaptcha":
      return `https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off${hl}`;
    case "turnstile":
      return "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    case "cap":
      return `https://cdn.jsdelivr.net/npm/cap-widget@${CAP_WIDGET_VERSION}`;
  }
}

/** Sources a page showing the widget has to allow, per CSP directive. */
export type CspSources = {
  script: string[];
  frame: string[];
  connect: string[];
  style: string[];
};

export function captchaCspSources(config: CaptchaWidgetConfig): CspSources {
  switch (config.provider) {
    case "recaptcha":
      return {
        script: ["https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
        frame: ["https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"],
        connect: [],
        style: [],
      };
    case "hcaptcha":
      return {
        script: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
        frame: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
        connect: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
        style: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
      };
    case "turnstile":
      return {
        script: ["https://challenges.cloudflare.com"],
        frame: ["https://challenges.cloudflare.com"],
        connect: [],
        style: [],
      };
    case "cap": {
      // Its proof of work runs in WebAssembly, fetched from jsDelivr like the widget.
      const instance = originOf(config.capApiEndpoint);
      return {
        script: ["https://cdn.jsdelivr.net", "'wasm-unsafe-eval'"],
        frame: [],
        connect: ["https://cdn.jsdelivr.net", ...(instance ? [instance] : [])],
        style: [],
      };
    }
  }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
