"use client";

import { type ReactNode, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CaptchaWidget, type CaptchaWidgetHandle } from "@/src/components/auth/CaptchaWidget";
import type { CaptchaWidgetConfig } from "@/src/lib/captcha/providers";

/** Keyed by the code the route refuses with. */
const CAPTCHA_ERRORS = {
  CAPTCHA_FAILED: "failed",
  CAPTCHA_UNAVAILABLE: "unavailable",
  TOO_MANY_REQUESTS: "tooManyChecks",
} as const;

/**
 * Shared by `/login` and the portal. Every password attempt spends a pass, so each needs a solve;
 * `widget` is non-null exactly while one is needed, and `pass` succeeds at once otherwise.
 */
export function useCaptchaStep({
  config,
  nonce,
  onError,
}: {
  config: CaptchaWidgetConfig | null;
  nonce?: string;
  onError: (message: string) => void;
}): {
  widget: ReactNode;
  pending: boolean;
  /** True once a pass is held. */
  pass: (username: string) => Promise<boolean>;
  /** The pass was spent, lapsed or belongs to another name: the next attempt needs a new solve. */
  spent: (message?: "expired") => void;
} {
  const t = useTranslations("auth.login.captcha");
  const ref = useRef<CaptchaWidgetHandle>(null);
  const [needed, setNeeded] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const pass = async (username: string): Promise<boolean> => {
    if (!config || !needed) return true;
    if (!token) {
      onError(t("required"));
      return false;
    }
    setPending(true);
    try {
      const response = await fetch("/api/sign-in/captcha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, token }),
      });
      if (response.ok) {
        setNeeded(false);
        setToken(null);
        return true;
      }
      const { code } = (await response.json().catch(() => ({}))) as { code?: string };
      const key =
        code && Object.hasOwn(CAPTCHA_ERRORS, code)
          ? CAPTCHA_ERRORS[code as keyof typeof CAPTCHA_ERRORS]
          : "failed";
      onError(t(key));
    } catch {
      onError(t("unavailable"));
    } finally {
      setPending(false);
    }
    // Spent or suspect, whatever went wrong.
    ref.current?.reset();
    return false;
  };

  const spent = (message?: "expired") => {
    // Only a remount gives a fresh challenge.
    setNeeded(true);
    setToken(null);
    if (message) onError(t(message));
  };

  const widget =
    config && needed ? (
      <CaptchaWidget
        ref={ref}
        config={config}
        nonce={nonce}
        onToken={setToken}
        onError={() => onError(t("loadFailed"))}
      />
    ) : null;

  return { widget, pending, pass, spent };
}
