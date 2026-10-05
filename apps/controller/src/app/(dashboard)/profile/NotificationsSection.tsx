"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Timestamp } from "@/components/ui/Timestamp";
import { type DeviceWords, describeDevice } from "./device";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { InfoAlert, StatusAlert, WarnAlert } from "@/src/components/ui/FormLayout";
import type { UnavailableReason } from "@/src/lib/notifications/availability";
import { settingDescription, settingLabel } from "@/src/lib/settings/messages";
import {
  type NotificationActionResult,
  pushSubscriptionKnownAction,
  removePushBrowserAction,
  saveNotificationPreferencesAction,
  sendTestPushAction,
  subscribePushAction,
  unsubscribePushAction,
} from "./notification-actions";

export type NotificationsSectionProps = {
  /** As sent today: the stored choice, or the default the Recipients list implies. */
  preferences: { email: boolean; push: boolean; muted: string[] };
  /** "off": SMTP is not set up. "undeliverable": this account's address cannot receive mail. */
  emailState: "ready" | "off" | "undeliverable";
  address: string;
  categories: {
    category: string;
    settingKey: string;
    enabled: boolean;
    /** Why the event cannot happen under the current settings, or null. */
    unavailable: UnavailableReason | null;
  }[];
  pushPublicKey: string | null;
  /** Every browser this account turned push on in, so one left behind can be removed. */
  browsers: { id: number; userAgent: string | null; createdAt: string }[];
};

/** Each change saves at once, like the table density; a refused save puts it back. */
export function NotificationsSection({
  preferences: initial,
  emailState,
  address,
  categories,
  pushPublicKey,
  browsers,
}: NotificationsSectionProps) {
  const t = useTranslations("profile.notifications");
  const tCommon = useTranslations("common");
  const tRoot = useTranslations();
  const [preferences, setPreferences] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const save = (next: typeof preferences) => {
    const previous = preferences;
    setPreferences(next);
    setError(null);
    startSaving(async () => {
      const result = await saveNotificationPreferencesAction(next).catch(
        (): NotificationActionResult => ({ success: false, message: t("saveFailed") }),
      );
      if (!result.success) {
        setPreferences(previous);
        setError(result.message ?? t("saveFailed"));
      }
    });
  };

  const muted = new Set(preferences.muted);

  return (
    <VStack gap={4}>
      <Text type="body" size="sm" color="secondary">
        {t("description")}
      </Text>
      {error && <StatusAlert message={error} success={false} />}

      <Switch
        label={tCommon("email")}
        description={
          emailState === "off"
            ? t("emailOff")
            : emailState === "undeliverable"
              ? t("emailUndeliverable", { address })
              : t("emailHelp", { address })
        }
        value={emailState === "ready" && preferences.email}
        isDisabled={emailState !== "ready" || saving}
        onChange={(email) => save({ ...preferences, email })}
      />
      <Switch
        label={t("push")}
        description={t("pushHelp")}
        value={preferences.push}
        isDisabled={saving}
        onChange={(push) => save({ ...preferences, push })}
      />
      {preferences.push && <PushBrowserForm publicKey={pushPublicKey} />}
      {browsers.length > 0 && <SubscribedBrowsers browsers={browsers} />}

      <Heading level={3}>{tCommon("events")}</Heading>
      <VStack gap={3}>
        {categories.map(({ category, settingKey, enabled, unavailable }) => (
          <Switch
            key={category}
            label={settingLabel(tRoot, settingKey)}
            description={
              !enabled
                ? t("eventOffForEveryone")
                : unavailable
                  ? tRoot(`settings.email.unavailable.${unavailable}`)
                  : settingDescription(tRoot, settingKey)
            }
            value={enabled && !unavailable && !muted.has(category)}
            isDisabled={!enabled || unavailable !== null || saving}
            onChange={(on) =>
              save({
                ...preferences,
                muted: on
                  ? preferences.muted.filter((name) => name !== category)
                  : [...preferences.muted, category],
              })
            }
          />
        ))}
      </VStack>
    </VStack>
  );
}

/** Removing one here stops pushes to it at once, from any browser: one lost or left signed in. */
function SubscribedBrowsers({ browsers }: { browsers: NotificationsSectionProps["browsers"] }) {
  const t = useTranslations("profile.notifications");
  const tCommon = useTranslations("common");
  const tProfile = useTranslations("profile");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<NotificationActionResult | null>(null);
  const words: DeviceWords = {
    unknown: tProfile("deviceUnknown"),
    browser: tProfile("deviceBrowser"),
    onOs: (browser, os) => tProfile("deviceOnOs", { browser, os }),
  };

  return (
    <VStack gap={2}>
      <Text type="label">{t("browsersTitle")}</Text>
      {browsers.map((browser) => (
        <HStack key={browser.id} gap={2} vAlign="center" justify="between" wrap="wrap">
          <VStack gap={0}>
            <Text type="body" size="sm">
              {describeDevice(browser.userAgent, words)}
            </Text>
            <Text type="supporting" color="secondary">
              <Timestamp value={browser.createdAt} />
            </Text>
          </VStack>
          <Button
            variant="ghost"
            size="sm"
            label={tCommon("remove")}
            isDisabled={pending}
            onClick={() =>
              startTransition(async () => {
                setResult(await removePushBrowserAction(browser.id));
                router.refresh();
              })
            }
          />
        </HStack>
      ))}
      {result?.message && <StatusAlert message={result.message} success={result.success} />}
    </VStack>
  );
}

type PushState = "checking" | "unsupported" | "blocked" | "off" | "on";

function pushSupported(): boolean {
  return (
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The VAPID key as `subscribe` wants it: base64url text to bytes. */
function applicationServerKey(key: string): Uint8Array<ArrayBuffer> {
  const base64 = (key + "=".repeat((4 - (key.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Per browser: the switch above says whether to push at all, this which browsers get it. */
function PushBrowserForm({ publicKey }: { publicKey: string | null }) {
  const t = useTranslations("profile.notifications");
  const [state, setState] = useState<PushState>("checking");
  const [result, setResult] = useState<NotificationActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    let cancelled = false;
    void currentSubscription()
      .then(async (subscription) =>
        subscription && Notification.permission === "granted"
          ? await pushSubscriptionKnownAction(subscription.endpoint)
          : false,
      )
      .catch(() => false)
      .then((known) => {
        if (!cancelled) setState(known ? "on" : "off");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = () => {
    if (!publicKey) return;
    // Asked before any await: browsers only prompt from inside the click.
    const permission = Notification.requestPermission();
    setResult(null);
    startTransition(async () => {
      try {
        if ((await permission) !== "granted") {
          setState(Notification.permission === "denied" ? "blocked" : "off");
          return;
        }
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        // A subscription made with another key (a restored database) would never be accepted.
        await (await registration.pushManager.getSubscription())?.unsubscribe();
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        });
        const saved = await subscribePushAction(subscription.toJSON());
        if (!saved.success) await subscription.unsubscribe();
        setState(saved.success ? "on" : "off");
        setResult(saved);
      } catch (error) {
        console.error("Could not turn browser notifications on:", error);
        setResult({ success: false, message: t("pushEnableFailed") });
      }
    });
  };

  const disable = () => {
    setResult(null);
    startTransition(async () => {
      try {
        const subscription = await currentSubscription();
        if (subscription) {
          const removed = await unsubscribePushAction(subscription.endpoint);
          await subscription.unsubscribe();
          setResult(removed);
        }
        setState("off");
      } catch (error) {
        console.error("Could not turn browser notifications off:", error);
        setResult({ success: false, message: t("pushDisableFailed") });
      }
    });
  };

  const test = () => {
    setResult(null);
    startTransition(async () => {
      const subscription = await currentSubscription().catch(() => null);
      setResult(
        subscription
          ? await sendTestPushAction(subscription.endpoint)
          : { success: false, message: t("pushTestNotSubscribed") },
      );
    });
  };

  const status = {
    checking: t("pushChecking"),
    unsupported: t("pushUnsupported"),
    blocked: t("pushBlocked"),
    off: t("pushOff"),
    on: t("pushOn"),
  }[state];

  return (
    <VStack gap={2}>
      {!publicKey && state !== "unsupported" ? (
        <WarnAlert title={t("pushNoKey")} />
      ) : state === "unsupported" || state === "blocked" ? (
        <InfoAlert title={status} />
      ) : (
        <HStack gap={2} vAlign="center" wrap="wrap">
          {state === "on" ? (
            <>
              <Button
                variant="secondary"
                label={t("pushTest")}
                onClick={test}
                isLoading={pending}
                isDisabled={pending}
              />
              <Button
                variant="secondary"
                label={t("pushDisable")}
                onClick={disable}
                isDisabled={pending}
              />
            </>
          ) : (
            <Button
              variant="secondary"
              label={t("pushEnable")}
              onClick={enable}
              isLoading={pending}
              isDisabled={pending || state === "checking"}
            />
          )}
          <Text size="sm" color="secondary">
            {status}
          </Text>
        </HStack>
      )}
      {result?.message && <StatusAlert message={result.message} success={result.success} />}
    </VStack>
  );
}
