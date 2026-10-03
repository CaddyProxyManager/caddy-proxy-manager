/**
 * Who a batch goes to, and how: each active administrator by their own choices (Profile →
 * Notifications), plus the Recipients list as extra addresses that get every enabled event.
 *
 * An administrator who never chose is emailed when the list is empty or names them, which is who
 * was emailed before the choice existed. A listed address that is an administrator's follows that
 * administrator's choice, so they can turn their own email off.
 */

import { isEmailAddress } from "../email-address";
import { allNotificationPreferences } from "../models/notification-preferences";
import { adminPushTargets, type PushTarget } from "../models/push-subscriptions";
import type { NotificationCategory } from "./events";

export type Audience = {
  /** Stable across sends, so a retried batch skips whoever already has it. */
  key: string;
  /** Null: the list's extras, and anything with no category (the test). */
  muted: ReadonlySet<NotificationCategory> | null;
} & ({ kind: "email"; address: string } | { kind: "push"; targets: PushTarget[] });

export function audienceWants(audience: Audience, category: NotificationCategory | null): boolean {
  return category === null || !audience.muted?.has(category);
}

/** The Recipients list: extra addresses, and the default for whoever never chose. */
async function listedRecipients(): Promise<string[]> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  return (await getSetting(registry.emailAlertRecipients))
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

function emailByDefault(address: string, listed: readonly string[]): boolean {
  return (
    listed.length === 0 || listed.some((entry) => entry.toLowerCase() === address.toLowerCase())
  );
}

/** One administrator's choices as they stand, defaults filled in, for Profile → Notifications. */
export async function notificationProfileView(user: { id: number; email: string }) {
  const [{ getNotificationPreferences }, { emailReady }, { notificationCategoryStates }, listed] =
    await Promise.all([
      import("../models/notification-preferences"),
      import("../email/config"),
      import("./index"),
      listedRecipients(),
    ]);
  const { unavailableNotificationCategories } = await import("./availability");
  const [chosen, ready, states, unavailable, pushPublicKey] = await Promise.all([
    getNotificationPreferences(user.id),
    emailReady(),
    notificationCategoryStates(),
    unavailableNotificationCategories(),
    import("./push")
      .then(({ vapidKeys }) => vapidKeys())
      .then(({ publicKey }) => publicKey)
      .catch((error: unknown) => {
        console.error("[notifications] could not read the push keys:", error);
        return null;
      }),
  ]);
  const emailState: "ready" | "off" | "undeliverable" = !ready
    ? "off"
    : isEmailAddress(user.email, "public")
      ? "ready"
      : "undeliverable";
  return {
    preferences: {
      email: chosen.email ?? emailByDefault(user.email, listed),
      push: chosen.push,
      muted: chosen.muted,
    },
    emailState,
    address: user.email,
    categories: states.map((state) => ({
      ...state,
      unavailable: unavailable[state.category] ?? null,
    })),
    pushPublicKey,
  };
}

export async function notificationAudiences(options: { email: boolean }): Promise<Audience[]> {
  const { listUsers } = await import("../models/user");
  const [listed, admins, preferences, targets] = await Promise.all([
    listedRecipients(),
    listUsers().then((users) =>
      users.filter((user) => user.role === "admin" && user.status === "active"),
    ),
    allNotificationPreferences(),
    adminPushTargets(),
  ]);

  const audiences: Audience[] = [];
  const emailed = new Set<string>();
  const adminAddresses = new Set(admins.map((admin) => admin.email.toLowerCase()));

  for (const admin of admins) {
    const chosen = preferences.get(admin.id);
    const muted = new Set(chosen?.muted ?? []);
    const address = admin.email.toLowerCase();

    const wantsEmail = chosen?.email ?? emailByDefault(admin.email, listed);
    // `name@localhost`, as setup names the first administrator, has nowhere to be delivered.
    if (options.email && wantsEmail && isEmailAddress(admin.email, "public")) {
      emailed.add(address);
      audiences.push({ key: `email:${address}`, kind: "email", address: admin.email, muted });
    }

    const browsers = targets.filter((target) => target.userId === admin.id);
    if ((chosen?.push ?? true) && browsers.length > 0) {
      audiences.push({ key: `push:${admin.id}`, kind: "push", targets: browsers, muted });
    }
  }

  if (options.email) {
    for (const address of listed) {
      const lower = address.toLowerCase();
      if (emailed.has(lower) || adminAddresses.has(lower)) continue;
      emailed.add(lower);
      audiences.push({ key: `email:${lower}`, kind: "email", address, muted: null });
    }
  }
  return audiences;
}
