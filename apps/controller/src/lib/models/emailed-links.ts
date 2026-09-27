/**
 * Emailed links that set a password: a reset for someone who forgot theirs, an invitation for an
 * account an administrator created without one. Rows live in Better Auth's `verifications` table
 * under a prefix of their own, keyed by a hash so a database read cannot be turned into a link.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, like, lt } from "drizzle-orm";
import db, { nowIso } from "../db";
import { verifications } from "../db/schema";

export type EmailedLinkPurpose = "reset" | "invite";

export const EMAILED_LINK_TTL_MS: Record<EmailedLinkPurpose, number> = {
  // Short, as the mailbox may be read by more than its owner; asking again is cheap.
  reset: 60 * 60 * 1000,
  // Long enough to outlast a weekend between being created and reading the mail.
  invite: 7 * 24 * 60 * 60 * 1000,
};

const PREFIX = "cpm-password-link:";

export type EmailedLink = { userId: number; purpose: EmailedLinkPurpose; expiresAt: string };

function identifierFor(token: string): string {
  return `${PREFIX}${createHash("sha256").update(token).digest("hex")}`;
}

function parseValue(value: string): Omit<EmailedLink, "expiresAt"> | null {
  try {
    const parsed = JSON.parse(value) as { userId?: unknown; purpose?: unknown };
    if (typeof parsed.userId !== "number") return null;
    if (parsed.purpose !== "reset" && parsed.purpose !== "invite") return null;
    return { userId: parsed.userId, purpose: parsed.purpose };
  } catch {
    return null;
  }
}

/** Replaces any link the user already holds, so only the newest email works. */
export async function issueEmailedLink(
  userId: number,
  purpose: EmailedLinkPurpose,
  now = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const created = new Date(now).toISOString();
  await revokeEmailedLinks(userId);
  await db
    .delete(verifications)
    .where(and(like(verifications.identifier, `${PREFIX}%`), lt(verifications.expiresAt, created)));

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + EMAILED_LINK_TTL_MS[purpose]).toISOString();
  await db.insert(verifications).values({
    identifier: identifierFor(token),
    value: JSON.stringify({ userId, purpose }),
    expiresAt,
    createdAt: created,
    updatedAt: created,
  });
  return { token, expiresAt };
}

/** Without consuming it, so the form can say a link is dead before a password is typed. */
export async function findEmailedLink(token: string): Promise<EmailedLink | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifierFor(token)),
        gt(verifications.expiresAt, nowIso()),
      ),
    )
    .limit(1);
  const parsed = row ? parseValue(row.value) : null;
  return parsed && row ? { ...parsed, expiresAt: row.expiresAt } : null;
}

/** Deletes and returns in one statement, so two submissions of one link cannot both succeed. */
export async function redeemEmailedLink(token: string): Promise<EmailedLink | null> {
  if (!token) return null;
  const [row] = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, identifierFor(token)),
        gt(verifications.expiresAt, nowIso()),
      ),
    )
    .returning();
  const parsed = row ? parseValue(row.value) : null;
  return parsed && row ? { ...parsed, expiresAt: row.expiresAt } : null;
}

export async function revokeEmailedLinks(userId: number): Promise<void> {
  const rows = await db
    .select({ id: verifications.id, value: verifications.value })
    .from(verifications)
    .where(like(verifications.identifier, `${PREFIX}%`));
  for (const row of rows) {
    if (parseValue(row.value)?.userId === userId) {
      await db.delete(verifications).where(eq(verifications.id, row.id));
    }
  }
}
