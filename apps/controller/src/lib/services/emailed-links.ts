/**
 * Password resets and invitations, end to end. The link carries the token in its fragment: a
 * fragment never reaches a server, so it stays out of Caddy's access log and the analytics that
 * the dashboard host's own traffic lands in.
 */

import { type SQL, eq, or } from "drizzle-orm";
import db from "../db";
import { users } from "../db/schema";
import { localUsersDisabled } from "../auth-policy";
import { isDemoAdmin } from "../demo-mode";
import { domainError } from "../domain-error";
import type { Locale } from "../locale";
import { hashPassword } from "../password";
import { getPublicBaseUrl } from "../public-url";
import { accountKey, resetAccountFailures } from "../rate-limit";
import { emailReady } from "../email/config";
import { inviteEmail, resetLinkEmail } from "../email/messages";
import { sendEmail } from "../email/transport";
import { createAuditEvent } from "../models/audit";
import {
  EMAILED_LINK_TTL_MS,
  type EmailedLinkPurpose,
  findEmailedLink,
  issueEmailedLink,
  redeemEmailedLink,
  revokeEmailedLinks,
} from "../models/emailed-links";
import { revokeSessionsAfterPasswordChange } from "../models/sessions";
import { getUserById, updateUserPassword, usersWithPassword } from "../models/user";

export const EMAILED_LINK_PATH = "/login/reset-password";

async function linkFor(token: string): Promise<string> {
  return `${await getPublicBaseUrl()}${EMAILED_LINK_PATH}#${token}`;
}

type Account = {
  id: number;
  email: string;
  username: string | null;
  provider: string | null;
  passwordHash: string | null;
  status: string;
};

async function findAccount(where: SQL | undefined): Promise<Account | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      provider: users.provider,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(where)
    .limit(1);
  return row ?? null;
}

/**
 * Local accounts only. An SSO account never had a password, and giving it one by email would open
 * a way in that goes around its identity provider.
 */
async function isLocalAccount(account: Account): Promise<boolean> {
  if (account.provider === "credentials" || account.passwordHash) return true;
  return (await usersWithPassword()).has(account.id);
}

/**
 * Silent whatever happens, so the answer cannot tell anyone which addresses have accounts. The
 * caller does not wait for it either: a sent message takes seconds, a skipped one none.
 */
export async function requestPasswordReset(identifier: string, locale: Locale): Promise<void> {
  const value = identifier.trim().toLowerCase();
  if (!value || (await localUsersDisabled()) || !(await emailReady())) return;

  const account = await findAccount(or(eq(users.email, value), eq(users.username, value)));
  if (account?.status !== "active" || isDemoAdmin(account.id)) return;
  if (!(await isLocalAccount(account))) return;

  const { token } = await issueEmailedLink(account.id, "reset");
  await sendEmail(
    await resetLinkEmail(
      {
        to: account.email,
        link: await linkFor(token),
        minutes: EMAILED_LINK_TTL_MS.reset / 60_000,
      },
      locale,
    ),
  );
  await createAuditEvent({
    userId: account.id,
    action: "password_reset_requested",
    entityType: "user",
    entityId: account.id,
    summary: "User asked for a password reset link",
  });
}

/**
 * Sent by an administrator: an invitation to an account with no password yet, a reset link to one
 * with. Throws, unlike the self-service request - the administrator should see a refusal.
 */
export async function sendEmailedLink(
  userId: number,
  inviter: string,
  locale: Locale,
): Promise<EmailedLinkPurpose> {
  if (await localUsersDisabled()) throw domainError("localUserCreationDisabled");
  if (!(await emailReady())) throw domainError("emailNotConfigured");

  const account = await findAccount(eq(users.id, userId));
  if (!account) throw domainError("userNotFound", {}, { status: 404 });
  if (isDemoAdmin(account.id)) throw domainError("demoAdminProtected", {}, { status: 403 });
  if (!(await isLocalAccount(account))) throw domainError("passwordLinkSsoAccount");

  const hasPassword = account.passwordHash !== null || (await usersWithPassword()).has(account.id);
  const purpose: EmailedLinkPurpose = hasPassword ? "reset" : "invite";
  const { token } = await issueEmailedLink(account.id, purpose);
  const link = await linkFor(token);
  const message =
    purpose === "invite"
      ? await inviteEmail(
          {
            to: account.email,
            link,
            days: EMAILED_LINK_TTL_MS.invite / 86_400_000,
            inviter,
          },
          locale,
        )
      : await resetLinkEmail(
          { to: account.email, link, minutes: EMAILED_LINK_TTL_MS.reset / 60_000 },
          locale,
        );
  try {
    await sendEmail(message);
  } catch (error) {
    // A link nobody received should not stay redeemable.
    await revokeEmailedLinks(account.id);
    throw error;
  }
  return purpose;
}

/** What the form shows before a password is typed; null for a dead link. */
export async function describeEmailedLink(
  token: string,
): Promise<{ purpose: EmailedLinkPurpose; username: string } | null> {
  const link = await findEmailedLink(token);
  if (!link) return null;
  const account = await findAccount(eq(users.id, link.userId));
  if (account?.status !== "active") return null;
  return { purpose: link.purpose, username: account.username ?? account.email };
}

/** The caller has already checked `password` against the policy, so a refusal keeps the link. */
export async function completeEmailedLink(
  token: string,
  password: string,
): Promise<{ userId: number; purpose: EmailedLinkPurpose }> {
  if (await localUsersDisabled()) throw domainError("passwordLinkInvalid");

  const link = await redeemEmailedLink(token);
  if (!link) throw domainError("passwordLinkInvalid");
  const user = await getUserById(link.userId);
  if (user?.status !== "active") throw domainError("passwordLinkInvalid");

  await updateUserPassword(user.id, await hashPassword(password));
  // Whoever had the old password, or a session on it, is out; so is any other link in the inbox.
  await revokeSessionsAfterPasswordChange(user.id, null);
  await revokeEmailedLinks(user.id);

  const account = await findAccount(eq(users.id, user.id));
  for (const name of [user.email, account?.username]) {
    if (name) resetAccountFailures(accountKey(name));
  }

  await createAuditEvent({
    userId: user.id,
    action: link.purpose === "invite" ? "password_set" : "password_reset",
    entityType: "user",
    entityId: user.id,
    summary:
      link.purpose === "invite"
        ? "User set a password from an invitation"
        : "User reset their password from an emailed link",
  });
  return { userId: user.id, purpose: link.purpose };
}
