"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { authClient } from "@/src/lib/auth/client";
import { passkeyError } from "@/src/lib/auth/passkeys/error";

type PasskeySignInResult = {
  data: unknown;
  error: { status?: number; code?: string; message?: string } | null;
};
type SignInPasskey = (options?: { autoFill?: boolean }) => Promise<PasskeySignInResult>;

/**
 * Passkey sign-in for /login and the portal: a button, and the username field's autofill where the
 * browser offers conditional UI. Either way the result is a dashboard session.
 */
export function usePasskeySignIn({
  enabled,
  onSignedIn,
  onError,
}: {
  enabled: boolean;
  onSignedIn: () => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("auth.passkey");
  // After mount: the server render cannot know, and a mismatch would fail hydration.
  const [supported, setSupported] = useState(false);
  const [pending, setPending] = useState(false);
  // The effect below runs once; these change identity every render.
  const handlers = useRef({ onSignedIn, onError, t });
  handlers.current = { onSignedIn, onError, t };

  const run = async (autoFill: boolean) => {
    // The shape the plugin's client returns; its inferred type does not reach through the cast.
    const signIn = (authClient.signIn as unknown as { passkey: SignInPasskey }).passkey;
    const { error } = await signIn(autoFill ? { autoFill: true } : undefined);
    if (!error) {
      handlers.current.onSignedIn();
      return true;
    }
    const refused = passkeyError(error, "signIn");
    if (refused) {
      handlers.current.onError(
        "message" in refused ? refused.message : handlers.current.t(refused.key),
      );
    }
    return false;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount; `run` reads refs
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !window.PublicKeyCredential) return;
    setSupported(true);
    let cancelled = false;
    PublicKeyCredential.isConditionalMediationAvailable?.()
      .then((available) => {
        // Waits in the background until a passkey is picked from the username field's list.
        if (available && !cancelled) void run(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const start = async () => {
    setPending(true);
    // A modal ceremony aborts the autofill one, which then reports a silent cancellation.
    const signedIn = await run(false);
    if (!signedIn) setPending(false);
  };

  return { supported: enabled && supported, pending, start };
}
