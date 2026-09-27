"use server";

import { localUsersDisabled } from "@/src/lib/auth-policy";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { domainError } from "@/src/lib/domain-error";
import {
  createUser,
  updateUserProfile,
  updateUserRole,
  updateUserStatus,
  deleteUser,
  getUserById,
  type User,
} from "@/src/lib/models/user";
import { revokeSessionsAfterPasswordChange } from "@/src/lib/models/sessions";
import { resetTwoFactor } from "@/src/lib/two-factor";
import { logAuditEvent } from "@/src/lib/audit";
import { hashPassword } from "@/src/lib/password";
import { getTranslations } from "next-intl/server";
import { actionError, actionSuccess, type ActionState } from "@/src/lib/actions";
import {
  assertAcceptablePassword,
  assertEmailAddress,
  assertNotSelf,
  assertUserRole,
  assertUserStatus,
} from "@/src/lib/user-admin";

async function createUserActionUntranslated(formData: FormData) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  if (await localUsersDisabled()) {
    throw domainError("localUserCreationDisabled");
  }

  const email = String(formData.get("email") ?? "").trim();
  const name = formData.get("name") ? String(formData.get("name")).trim() : null;
  const role = assertUserRole(String(formData.get("role") ?? "user"));
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    throw domainError("emailAndPasswordRequired");
  }
  assertEmailAddress(email);
  assertAcceptablePassword(password);

  const passwordHash = await hashPassword(password);

  const user = await createUser({
    email,
    name,
    role,
    provider: "credentials",
    subject: email,
    passwordHash,
  });

  await logAuditEvent({
    userId: actorId,
    action: "create",
    entityType: "user",
    entityId: user.id,
    summary: `Created user ${user.id} (${email}) with role ${role}`,
  });

  revalidatePath("/users");
}

async function updateUserRoleActionUntranslated(userId: number, requestedRole: User["role"]) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  assertNotSelf(actorId, userId, "cannotChangeOwnRole");
  // A server action is a public endpoint: the type annotation is not a check on what arrives.
  const role = assertUserRole(requestedRole);

  await updateUserRole(userId, role);

  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Changed user ${userId} role to ${role}`,
  });

  revalidatePath("/users");
}

async function updateUserStatusActionUntranslated(userId: number, requestedStatus: string) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  assertNotSelf(actorId, userId, "cannotChangeOwnStatus");
  const status = assertUserStatus(requestedStatus);

  await updateUserStatus(userId, status);

  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Changed user ${userId} status to ${status}`,
  });

  revalidatePath("/users");
}

async function updateUserInfoActionUntranslated(userId: number, formData: FormData) {
  const session = await requireAdmin();
  const actorId = Number(session.user.id);

  const name = formData.get("name") ? String(formData.get("name")).trim() : undefined;
  const email = formData.get("email") ? String(formData.get("email")).trim() : undefined;
  if (email !== undefined) assertEmailAddress(email);

  await updateUserProfile(userId, { name, email });

  await logAuditEvent({
    userId: actorId,
    action: "update",
    entityType: "user",
    entityId: userId,
    summary: `Updated user ${userId} profile`,
  });

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

/*
 * Failures here used to reach the browser as an unhandled rejection and show the reader nothing.
 * They return an ActionState now, translated on the server, which UsersClient renders - the same
 * shape the proxy-host and L4 actions already use.
 */

export async function createUserAction(formData: FormData): Promise<ActionState> {
  try {
    await createUserActionUntranslated(formData);
    return actionSuccess();
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

/**
 * For someone who lost their authenticator and backup codes. Their sessions go too: the reset
 * often follows a lost or stolen device, and is a clean point to sign in fresh.
 */
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
