/**
 * The one message a disabled account may get: its owner told that it was disabled, when Settings
 * says to. Sent at once rather than batched, since the batches go to administrators. Never throws:
 * disabling must not fail over an email.
 */

import type { User } from "../models/user";

export type AccountDisabledReason =
  | { by: "administrator" }
  | { by: "failedSignIns"; failures: number };

export async function tellOwnerAccountDisabled(
  user: Pick<User, "email">,
  reason: AccountDisabledReason,
): Promise<void> {
  try {
    const [{ isDemoMode }, registry, { getSetting }, { emailReady }, { isEmailAddress }] =
      await Promise.all([
        import("../demo/mode"),
        import("../settings/registry"),
        import("../settings/resolve"),
        import("../email/config"),
        import("../email/address"),
      ]);
    if (isDemoMode() || !(await getSetting(registry.notifyDisabledAccountOwner))) return;
    if (!isEmailAddress(user.email, "public") || !(await emailReady())) return;

    const [{ accountDisabledEmail }, { sendEmail }] = await Promise.all([
      import("../email/messages"),
      import("../email/transport"),
    ]);
    await sendEmail(await accountDisabledEmail({ to: user.email, reason }));
  } catch (error) {
    console.error("[notifications] could not tell an account's owner it was disabled:", error);
  }
}
