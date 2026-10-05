"use client";

/** Provider scripts load on first mount only, so a deployment without a CAPTCHA contacts none. */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { type CaptchaWidgetConfig, captchaScriptUrl } from "@/src/lib/captcha/providers";

/** reCAPTCHA, hCaptcha and Turnstile share this explicit-render API closely enough. */
type RenderApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string | number;
  reset: (id?: string | number) => void;
  remove?: (id?: string | number) => void;
};

type CaptchaWindow = Window & {
  grecaptcha?: RenderApi;
  hcaptcha?: RenderApi;
  turnstile?: RenderApi;
  CAP_SCRIPT_NONCE?: string;
  CAP_CSS_NONCE?: string;
};

export type CaptchaWidgetHandle = {
  /** Tokens are single-use, so one the server has already spent must be solved again. */
  reset: () => void;
};

type Props = {
  config: CaptchaWidgetConfig;
  /** The page's CSP nonce, for the scripts Cap injects into its own sandbox. */
  nonce?: string;
  /** Null once it expires or errors. */
  onToken: (token: string | null) => void;
  onError: () => void;
};

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string, nonce?: string): Promise<void> {
  let pending = scripts.get(src);
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      if (nonce) script.nonce = nonce;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
    // A failed load is retried on the next mount rather than remembered.
    pending.catch(() => scripts.delete(src));
    scripts.set(src, pending);
  }
  return pending;
}

/** The script's onload fires before reCAPTCHA has finished defining `render`, so wait for it. */
async function renderApi(provider: "recaptcha" | "hcaptcha" | "turnstile"): Promise<RenderApi> {
  const global = { recaptcha: "grecaptcha", hcaptcha: "hcaptcha", turnstile: "turnstile" }[
    provider
  ] as "grecaptcha" | "hcaptcha" | "turnstile";
  for (let waited = 0; waited < 15_000; waited += 100) {
    const api = (window as CaptchaWindow)[global];
    if (typeof api?.render === "function") return api;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${provider} did not initialise`);
}

function colourScheme(): "light" | "dark" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const CaptchaWidget = forwardRef<CaptchaWidgetHandle, Props>(function CaptchaWidget(
  { config, nonce, onToken, onError },
  ref,
) {
  const t = useTranslations("auth.login.captcha");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const resetRef = useRef<() => void>(() => {});
  // Latest callbacks without re-rendering the widget whenever the parent re-renders.
  const callbacks = useRef({ onToken, onError });
  callbacks.current = { onToken, onError };

  useImperativeHandle(ref, () => ({ reset: () => resetRef.current() }), []);

  // Cap takes labels as attributes, not a language; every one, or the rest stay English.
  const capLabels = {
    "data-cap-i18n-initial-state": t("capInitial"),
    "data-cap-i18n-verifying-label": tCommon("verifying"),
    "data-cap-i18n-solved-label": t("capSolved"),
    "data-cap-i18n-error-label": t("capError"),
    "data-cap-i18n-required-label": t("capRequired"),
    "data-cap-i18n-verify-aria-label": t("capVerifyAria"),
    "data-cap-i18n-verifying-aria-label": t("capVerifyingAria"),
    "data-cap-i18n-verified-aria-label": t("capVerifiedAria"),
    "data-cap-i18n-error-aria-label": t("capErrorAria"),
    "data-cap-i18n-wasm-disabled": t("capWasmDisabled"),
  };
  const capLabelsRef = useRef(capLabels);
  capLabelsRef.current = capLabels;

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let cancelled = false;
    let cleanup = () => {};

    const token = (value: string | null) => {
      if (!cancelled) callbacks.current.onToken(value);
    };

    (async () => {
      try {
        if (config.provider === "cap") {
          const w = window as CaptchaWindow;
          if (nonce) {
            w.CAP_SCRIPT_NONCE = nonce;
            w.CAP_CSS_NONCE = nonce;
          }
          await loadScript(captchaScriptUrl("cap"), nonce);
          await customElements.whenDefined("cap-widget");
          if (cancelled) return;
          const widget = document.createElement("cap-widget");
          widget.setAttribute("data-cap-api-endpoint", config.capApiEndpoint ?? "");
          for (const [name, value] of Object.entries(capLabelsRef.current)) {
            widget.setAttribute(name, value);
          }
          const onSolve = (event: Event) =>
            token((event as CustomEvent<{ token?: string }>).detail?.token ?? null);
          const onReset = () => token(null);
          const onFail = () => token(null);
          widget.addEventListener("solve", onSolve);
          widget.addEventListener("reset", onReset);
          widget.addEventListener("error", onFail);
          host.replaceChildren(widget);
          resetRef.current = () => {
            (widget as HTMLElement & { reset?: () => void }).reset?.();
            token(null);
          };
          cleanup = () => {
            widget.removeEventListener("solve", onSolve);
            widget.removeEventListener("reset", onReset);
            widget.removeEventListener("error", onFail);
            host.replaceChildren();
          };
          return;
        }

        await loadScript(captchaScriptUrl(config.provider, locale), nonce);
        const api = await renderApi(config.provider);
        if (cancelled) return;
        const target = document.createElement("div");
        host.replaceChildren(target);
        const id = api.render(target, {
          sitekey: config.siteKey,
          theme: colourScheme(),
          // Turnstile takes its language here rather than on the script URL.
          ...(config.provider === "turnstile" ? { language: locale } : {}),
          callback: (value: string) => token(value),
          "expired-callback": () => token(null),
          "error-callback": () => token(null),
        });
        resetRef.current = () => {
          api.reset(id);
          token(null);
        };
        cleanup = () => {
          api.remove?.(id);
          host.replaceChildren();
        };
      } catch (error) {
        console.warn("[captcha] The widget could not be loaded:", error);
        if (!cancelled) callbacks.current.onError();
      }
    })();

    return () => {
      cancelled = true;
      resetRef.current = () => {};
      cleanup();
    };
  }, [config.provider, config.siteKey, config.capApiEndpoint, nonce, locale]);

  // A bare element: the provider owns everything inside it.
  return <div ref={container} />;
});
