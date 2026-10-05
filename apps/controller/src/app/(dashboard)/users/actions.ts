"use server";

import { localUsersDisabled } from "@/src/lib/auth/policy";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { domainError } from "@/src/lib/errors/domain-error";
import {
  createUser,
  updateUserAccount,
  updateUserRole,
  updateUserStatus,
  deleteUser,
  getUserById,
  type User,
} from "@/src/lib/models/user";
import { revokeSessionsAfterPasswordChange } from "@/src/lib/models/sessions";
import { resetTwoFactor } from "@/src/lib/forward-auth/two-factor";
import { deleteUserPasskeys } from "@/src/lib/auth/passkeys";
import { logAuditEvent } from "@/src/lib/audit";
import { diffAuditRecords } from "@/src/lib/audit/changes";
import { hashPassword } from "@/src/lib/auth/password";
import { getLocale, getTranslations } from "next-intl/server";
import { sendEmailedLink } from "@/src/lib/services/emailed-links";
import {
  actionError,
  actionSuccess,
  extractErrorMessage,
  type ActionState,
} from "@/src/lib/errors/action-error";
import {
  assertAcceptablePassword,
  assertEmailAddress,
  assertNotSelf,
  assertUserRole,
  assertUserStatus,
} from "@/src/lib/users/admin";

/** Returns why an invitation was not sent: the account exists regardless, and can be re-sent. */
async function createUserActionUntranslated(formData: FormData): Promise<unknown> {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  if (await localUsersDisabled()) {
    throw domainError("localUserCreationDisabled");
  }

  const email = String(formData.get("email") ?? "").trim();
  const name = formData.get("name") ? String(formData.get("name")).trim() : null;
  const role = assertUserRole(String(formData.get("role") ?? "user"));
  const password = String(formData.get("password") ?? "");
  // Empty: their own email when it can be a username (createUser).
  const username = String(formData.get("username") ?? "").trim() || null;
  // Without a password, the account can only be reached through the link the invitation carries.
  const invite = formData.get("invite") === "on";

  if (!email || (!password && !invite)) {
    throw domainError("emailAndPasswordRequired");
  }
  assertEmailAddress(email);
  if (!invite) assertAcceptablePassword(password);

  const passwordHash = invite ? null : await hashPassword(password);

  const user = await createUser({
    email,
    name,
    role,
    provider: "credentials",
    subject: email,
    passwordHash,
    username,
  });

  await logAuditEvent({
    userId: actorId,
    action: "create",
    entityType: "user",
    entityId: user.id,
    summary: `Created user ${user.id} (${email}) with role ${role}`,
  });

  revalidatePath("/users");
  if (!invite) return null;
  try {
    await sendEmailedLink(user.id, session.user.name || session.user.email, await getLocale());
    return null;
  } catch (error) {
    console.error("createUserAction: the invitation was not sent:", error);
    return error;
  }
}

async function updateUserRoleActionUntranslated(userId: number, requestedRole: User["role"]) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  assertNotSelf(actorId, userId, "cannotChangeOwnRole");
  // A server action is a public endpoint: the type annotation is not a check on what arrives.
  const role = assertUserRole(requestedRole);

  const before = await getUserById(userId);
  await updateUserRole(userId, role);

  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Changed user ${userId} role to ${role}`,
    changes: diffAuditRecords({ role: before?.role ?? null }, { role }),
  });

  revalidatePath("/users");
}

async function updateUserStatusActionUntranslated(userId: number, requestedStatus: string) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  assertNotSelf(actorId, userId, "cannotChangeOwnStatus");
  const status = assertUserStatus(requestedStatus);

  const before = await getUserById(userId);
  await updateUserStatus(userId, status);

  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Changed user ${userId} status to ${status}`,
    changes: diffAuditRecords({ status: before?.status ?? null }, { status }),
  });

  revalidatePath("/users");
}

async function updateUserInfoActionUntranslated(userId: number, formData: FormData) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  const name = formData.get("name") ? String(formData.get("name")).trim() : undefined;
  const email = formData.get("email") ? String(formData.get("email")).trim() : undefined;
  if (email !== undefined) assertEmailAddress(email);
  // A form without the field leaves the username alone.
  const username = formData.has("username") ? String(formData.get("username")) : undefined;

  const before = await getUserById(userId);
  // All or nothing: a refused username or email leaves the name unchanged too.
  const changed = await updateUserAccount(userId, { name, email, username });
  if (!changed) throw domainError("userNotFound");

  const profile = (user: User | null) =>
    user ? { name: user.name, email: user.email, username: user.username } : null;
  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Updated user ${userId} profile`,
    changes: diffAuditRecords(profile(before), profile(changed.user)),
  });
  if (changed.user.username !== changed.previousUsername) {
    await logAuditEvent({
      userId: actorId,
      action: "update",
      entityType: "user",
      entityId: userId,
      summary: `Changed user ${userId} sign-in username to ${changed.user.username}`,
      data: { previousUsername: changed.previousUsername, username: changed.user.username },
    });
  }

  revalidatePath("/users");
}

async function deleteUserActionUntranslated(userId: number) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  assertNotSelf(actorId, userId, "cannotDeleteOwnAccount");

  await deleteUser(userId);

  await logAuditEvent({
    userId: actorId,
    action: "delete",
    entityType: "user",
    entityId: userId,
    summary: `Deleted user ${userId}`,
  });

  revalidatePath("/users");
}

/* Failures return a translated ActionState, or the browser gets an unhandled rejection. */

/** A success carrying a message: created, but the invitation still has to be re-sent. */
export async function createUserAction(formData: FormData): Promise<ActionState> {
  try {
    const inviteError = await createUserActionUntranslated(formData);
    if (!inviteError) return actionSuccess();
    const t = await getTranslations();
    return actionSuccess(
      t("users.inviteNotSent", {
        error: extractErrorMessage(t, inviteError, t("errors.emailSendFailedUnknown")),
      }),
    );
  } catch (error) {
    const t = await getTranslations();
    console.error("createUserAction failed:", error);
    return actionError(t, error, t("errors.createUserFailed"));
  }
}

export async function updateUserRoleAction(
  userId: number,
  role: User["role"],
): Promise<ActionState> {
  try {
    await updateUserRoleActionUntranslated(userId, role);
    return actionSuccess();
  } catch (error) {
    const t = await getTranslations();
    console.error("updateUserRoleAction failed:", error);
    return actionError(t, error, t("errors.updateUserRoleFailed"));
  }
}

export async function updateUserStatusAction(userId: number, status: string): Promise<ActionState> {
  try {
    await updateUserStatusActionUntranslated(userId, status);
    return actionSuccess();
  } catch (error) {
    const t = await getTranslations();
    console.error("updateUserStatusAction failed:", error);
    return actionError(t, error, t("errors.updateUserStatusFailed"));
  }
}

export async function updateUserInfoAction(
  userId: number,
  formData: FormData,
): Promise<ActionState> {
  try {
    await updateUserInfoActionUntranslated(userId, formData);
    return actionSuccess();
  } catch (error) {
    const t = await getTranslations();
    console.error("updateUserInfoAction failed:", error);
    return actionError(t, error, t("errors.updateUserInfoFailed"));
  }
}

export async function deleteUserAction(userId: number): Promise<ActionState> {
  try {
    await deleteUserActionUntranslated(userId);
    return actionSuccess();
  } catch (error) {
    const t = await getTranslations();
    console.error("deleteUserAction failed:", error);
    return actionError(t, error, t("errors.deleteUserFailed"));
  }
}

/** Sessions go too: the reset often follows a lost or stolen device. */
async function resetUserTwoFactorActionUntranslated(userId: number) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);
  // Your own is turned off from the Profile page, with your password.
  assertNotSelf(actorId, userId, "cannotResetOwnTwoFactor");
  const target = await getUserById(userId);
  if (!target) throw domainError("userNotFound");

  await resetTwoFactor(userId);
  await revokeSessionsAfterPasswordChange(userId, null);
  await logAuditEvent({
    userId: actorId,
    action: "two_factor_reset",
    entityType: "user",
    entityId: userId,
    summary: `Two-factor sign-in reset for user ${target.email} by an administrator`,
  });
  revalidatePath("/users");
}

export async function resetUserTwoFactorAction(userId: number): Promise<ActionState> {
  try {
    await resetUserTwoFactorActionUntranslated(userId);
    const t = await getTranslations("users");
    return actionSuccess(t("twoFactorResetDone"));
  } catch (error) {
    const t = await getTranslations();
    console.error("resetUserTwoFactorAction failed:", error);
    return actionError(t, error, t("errors.resetTwoFactorFailed"));
  }
}

/** As the 2FA reset: sessions go too, since a lost device may have signed in with its passkey. */
async function removeUserPasskeysActionUntranslated(userId: number) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);
  // Your own are removed one at a time from the Profile page, behind its lock-out check.
  assertNotSelf(actorId, userId, "cannotRemoveOwnPasskeys");
  const target = await getUserById(userId);
  if (!target) throw domainError("userNotFound");

  await deleteUserPasskeys(userId);
  await revokeSessionsAfterPasswordChange(userId, null);
  await logAuditEvent({
    userId: actorId,
    action: "passkey_removed",
    entityType: "user",
    entityId: userId,
    summary: `Passkeys removed for user ${target.email} by an administrator`,
  });
  revalidatePath("/users");
}

export async function removeUserPasskeysAction(userId: number): Promise<ActionState> {
  try {
    await removeUserPasskeysActionUntranslated(userId);
    const t = await getTranslations("users");
    return actionSuccess(t("passkeysRemovedDone"));
  } catch (error) {
    const t = await getTranslations();
    console.error("removeUserPasskeysAction failed:", error);
    return actionError(t, error, t("errors.removePasskeysFailed"));
  }
}

/** An invitation to an account with no password yet, a reset link to one with. */
export async function sendEmailedLinkAction(userId: number): Promise<ActionState> {
  try {
    const session = await requireAdmin();
    const purpose = await sendEmailedLink(
      userId,
      session.user.name || session.user.email,
      await getLocale(),
    );
    const target = await getUserById(userId);
    await logAuditEvent({
      userId: Number(session.user.id),
      action: "password_link_sent",
      entityType: "user",
      entityId: userId,
      summary: `Emailed a password link to user ${target?.email ?? userId}`,
    });
    const t = await getTranslations("users");
    return actionSuccess(
      purpose === "invite"
        ? t("inviteSent", { email: target?.email ?? "" })
        : t("resetLinkSent", { email: target?.email ?? "" }),
    );
  } catch (error) {
    const t = await getTranslations();
    console.error("sendEmailedLinkAction failed:", error);
    return actionError(t, error, t("errors.emailSendFailedUnknown"));
  }
}
