import { decryptSecret, encryptSecret } from "../secret";
import { getSetting, setSetting } from "../settings";
import {
  type CaptchaProvider,
  type CaptchaWidgetConfig,
  capSiteUrl,
  isCaptchaProvider,
} from "./providers";

const KEY = "captcha";

/** As stored. `secretKey` is encrypted, and comes back that way - see `captchaSecret`. */
export type CaptchaSettings = {
  provider: CaptchaProvider | "none";
  siteKey: string;
  secretKey: string;
  /** Cap only: the Cap Standalone instance, without the site key. */
  capInstanceUrl: string;
};

export const DEFAULT_CAPTCHA_SETTINGS: CaptchaSettings = {
  provider: "none",
  siteKey: "",
  secretKey: "",
  capInstanceUrl: "",
};

/** For the form: the secret replaced by whether one is stored. */
export type CaptchaSettingsView = Omit<CaptchaSettings, "secretKey"> & { hasSecretKey: boolean };

function normalize(value: unknown): CaptchaSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_CAPTCHA_SETTINGS };
  const raw = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" ? field.trim() : "");
  return {
    provider: isCaptchaProvider(raw.provider) ? raw.provider : "none",
    siteKey: text(raw.siteKey),
    secretKey: text(raw.secretKey),
    capInstanceUrl: text(raw.capInstanceUrl),
  };
}

export async function getCaptchaSettings(): Promise<CaptchaSettings> {
  return normalize(await getSetting<unknown>(KEY));
}

export async function saveCaptchaSettings(value: CaptchaSettings): Promise<void> {
  const normalized = normalize(value);
  await setSetting(KEY, {
    ...normalized,
    // encryptSecret passes an already-encrypted value through, which is what a re-save sends.
    secretKey: normalized.secretKey ? encryptSecret(normalized.secretKey) : "",
  });
}

export function captchaSettingsView(settings: CaptchaSettings): CaptchaSettingsView {
  const { secretKey, ...rest } = settings;
  return { ...rest, hasSecretKey: secretKey.length > 0 };
}

/** Null when off or half configured: gating on a provider with no secret locks everyone out. */
export function activeCaptcha(settings: CaptchaSettings): CaptchaWidgetConfig | null {
  if (settings.provider === "none" || !settings.siteKey || !settings.secretKey) return null;
  if (settings.provider === "cap") {
    if (!settings.capInstanceUrl) return null;
    return {
      provider: "cap",
      siteKey: settings.siteKey,
      capApiEndpoint: capSiteUrl(settings.capInstanceUrl, settings.siteKey),
    };
  }
  return { provider: settings.provider, siteKey: settings.siteKey };
}

export async function getActiveCaptcha(): Promise<CaptchaWidgetConfig | null> {
  return activeCaptcha(await getCaptchaSettings());
}

/** The plaintext secret, for siteverify only. */
export function captchaSecret(settings: CaptchaSettings): string {
  return decryptSecret(settings.secretKey, "CAPTCHA secret key");
}
