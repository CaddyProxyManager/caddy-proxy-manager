"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import { getCurrentSessionId } from "@/src/lib/auth";
import { DEFAULT_LOCALE, parseLocale } from "@/src/lib/locale";
import { setNotificationPreferences } from "@/src/lib/models/notification-preferences";
import {
  deletePushSubscription,
  deletePushSubscriptionById,
  hasPushSubscription,
  parsePushSubscription,
  savePushSubscription,
} from "@/src/lib/models/push-subscriptions";

export type NotificationActionResult = { success: boolean; message?: string };

type FallbackKey = "saveFailed" | "pushEnableFailed" | "pushDisableFailed" | "pushTestFailed";

async function failure(error: unknown, fallback: FallbackKey): Promise<NotificationActionResult> {
  const [t, tAll, format] = await Promise.all([
    getTranslations("profile.notifications"),
    getTranslations(),
    getFormatter(),
  ]);
  return { success: false, message: extractErrorMessage(tAll, error, t(fallback), format) };
}

/**
 * A subscription's endpoint and keys are bearer credentials, and a database error's message can
 * carry its bound parameters: so these log the error's kind, never its message.
 */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The agents relay upstream errors only while some channel can carry them. */
async function refreshFleetConfig(): Promise<void> {
  const { pushFleetConfig } = await import("@/src/lib/agent/fleet-config");
  void pushFleetConfig().catch(() => {});
}

/** Administrators only: nobody else is notified, so there is nothing for anyone else to choose. */
export async function saveNotificationPreferencesAction(input: {
  email: boolean;
  push: boolean;
  muted: string[];
}): Promise<NotificationActionResult> {
  try {
    const session = await requireCan("alerts:read");
    // A server action is a public endpoint: the parameter's type is not a check on what arrives.
    await setNotificationPreferences(Number(session.user.id), {
      email: input?.email === true,
      push: input?.push !== false,
      muted: Array.isArray(input?.muted) ? input.muted.map(String) : [],
    });
    return { success: true };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to save notification preferences:", error);
    return failure(error, "saveFailed");
  }
}

/** This browser's subscription, for the signed-in administrator. */
export async function subscribePushAction(
  subscription: unknown,
): Promise<NotificationActionResult> {
  try {
    const t = await getTranslations("profile.notifications");
    const session = await requireCan("alerts:read");
    await savePushSubscription(
      Number(session.user.id),
      parsePushSubscription(subscription),
      parseLocale(await getLocale()) ?? DEFAULT_LOCALE,
      (await headers()).get("user-agent"),
      await getCurrentSessionId(),
    );
    await refreshFleetConfig();
    return { success: true, message: t("pushEnabled") };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to save a push subscription:", errorKind(error));
    return failure(error, "pushEnableFailed");
  }
}

export async function unsubscribePushAction(endpoint: string): Promise<NotificationActionResult> {
  try {
    const t = await getTranslations("profile.notifications");
    const session = await requireCan("alerts:read");
    await deletePushSubscription(Number(session.user.id), String(endpoint));
    await refreshFleetConfig();
    return { success: true, message: t("pushDisabled") };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to remove a push subscription:", errorKind(error));
    return failure(error, "pushDisableFailed");
  }
}

/** One of the caller's browsers, from Profile's list: for a browser that is not this one. */
export async function removePushBrowserAction(id: number): Promise<NotificationActionResult> {
  try {
    const t = await getTranslations("profile.notifications");
    const session = await requireCan("alerts:read");
    await deletePushSubscriptionById(Number(session.user.id), Number(id));
    await refreshFleetConfig();
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/profile");
    return { success: true, message: t("browserRemoved") };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to remove a push subscription:", errorKind(error));
    return failure(error, "pushDisableFailed");
  }
}

/** Whether this server still sends to it: one a push service gave up on is dropped here. */
export async function pushSubscriptionKnownAction(endpoint: string): Promise<boolean> {
  try {
    const session = await requireCan("alerts:read");
    return await hasPushSubscription(Number(session.user.id), String(endpoint));
  } catch (error) {
    unstable_rethrow(error);
    return false;
  }
}

/** To this browser alone, so it proves the subscription rather than whoever else has one. */
export async function sendTestPushAction(endpoint: string): Promise<NotificationActionResult> {
  try {
    const t = await getTranslations("profile.notifications");
    const session = await requireCan("alerts:read");
    const [{ adminPushTargets }, { sendPush }] = await Promise.all([
      import("@/src/lib/models/push-subscriptions"),
      import("@/src/lib/notifications/push"),
    ]);
    const userId = Number(session.user.id);
    const targets = (await adminPushTargets()).filter(
      (target) => target.userId === userId && target.endpoint === endpoint,
    );
    if (targets.length === 0) return { success: false, message: t("pushTestNotSubscribed") };
    const { delivered } = await sendPush(
      [{ id: "test", key: "test", at: new Date().toISOString(), event: { kind: "test" } }],
      targets,
    );
    return delivered > 0
      ? { success: true, message: t("pushTestSent") }
      : { success: false, message: t("pushTestFailed") };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to send a test push:", error);
    return failure(error, "pushTestFailed");
  }
}
