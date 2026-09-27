import db, { nowIso, toIso } from "../db";
import type { AppRole } from "../oidc-groups";
import { users, accounts, sessions } from "../db/schema";
import { and, count, desc, eq, max, ne } from "drizzle-orm";
import { deleteUserForwardAuthSessions } from "./forward-auth";
import { isDemoAdmin } from "../demo-mode";
import { domainError } from "../domain-error";
import { withRowLock } from "../db-claim";

/** See isDemoAdmin: the shared demo account keeps its password, its role and its access. */
function assertNotDemoAdmin(userId: number): void {
  if (isDemoAdmin(userId)) throw domainError("demoAdminProtected", {}, { status: 403 });
}

export type User = {
  id: number;
  email: string;
  name: string | null;
  passwordHash: string | null;
  /** When the login password was last set; null without one, or when it predates the record. */
  passwordChangedAt: string | null;
  role: AppRole;
  provider: string | null;
  subject: string | null;
  avatarUrl: string | null;
  status: string;
  twoFactorEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type DbUser = typeof users.$inferSelect;

function parseDbUser(user: DbUser): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
    passwordChangedAt: toIso(user.passwordChangedAt),
    role: user.role as AppRole,
    provider: user.provider,
    subject: user.subject,
    avatarUrl: user.avatarUrl,
    status: user.status,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: toIso(user.createdAt)!,
    updatedAt: toIso(user.updatedAt)!,
  };
}

export async function getUserById(userId: number): Promise<User | null> {
  const user = await db.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, userId),
  });
  return user ? parseDbUser(user) : null;
}

export async function getUserCount(): Promise<number> {
  const result = await db.select({ value: count() }).from(users);
  return result[0]?.value ?? 0;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.query.users.findFirst({
    where: (table, { eq }) => eq(table.email, normalizedEmail),
  });
  return user ? parseDbUser(user) : null;
}

export async function createUser(data: {
  email: string;
  name?: string | null;
  role?: User["role"];
  provider: string;
  subject: string;
  avatarUrl?: string | null;
  passwordHash?: string | null;
  username?: string | null;
  displayUsername?: string | null;
}): Promise<User> {
  const now = nowIso();
  const role = data.role ?? "user";
  const email = data.email.trim().toLowerCase();
  const provider = data.provider === "credential" ? "credentials" : data.provider;
  const username = data.username ?? email;
  const displayUsername = data.displayUsername ?? data.name ?? email.split("@")[0];

  const [user] = await db
    .insert(users)
    .values({
      email,
      name: data.name ?? null,
      passwordHash: data.passwordHash ?? null,
      passwordChangedAt: data.passwordHash ? now : null,
      role,
      provider,
      subject: data.subject,
      avatarUrl: data.avatarUrl ?? null,
      status: "active",
      username,
      displayUsername,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (provider === "credentials" && data.passwordHash) {
    await db.insert(accounts).values({
      userId: user.id,
      accountId: user.id.toString(),
      providerId: "credential",
      password: data.passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }

  return parseDbUser(user);
}

export async function updateUserProfile(
  userId: number,
  data: { email?: string; name?: string | null; avatarUrl?: string | null },
): Promise<User | null> {
  const current = await getUserById(userId);
  if (!current) {
    return null;
  }

  const now = nowIso();
  const [updated] = await db
    .update(users)
    .set({
      email: data.email ?? current.email,
      name: data.name ?? current.name,
      // An explicit null removes the icon (falling back to Gravatar or the initial); `??` would
      // make "remove profile picture" a silent no-op.
      avatarUrl: data.avatarUrl === undefined ? current.avatarUrl : data.avatarUrl,
      updatedAt: now,
    })
    .where(eq(users.id, userId))
    .returning();

  return updated ? parseDbUser(updated) : null;
}

export async function updateUserPassword(userId: number, passwordHash: string): Promise<void> {
  assertNotDemoAdmin(userId);
  const now = nowIso();
  await db
    .update(users)
    .set({
      passwordHash,
      passwordChangedAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, userId));

  // Also update the Better Auth credential account so the new password takes effect there too
  await db
    .update(accounts)
    .set({
      password: passwordHash,
      updatedAt: now,
    })
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
}

/**
 * Record that a user's password was just set, by a path that wrote the hash itself - Better Auth's
 * own endpoints, which reach the credential account without going through updateUserPassword.
 */
export async function markPasswordChanged(userId: number): Promise<void> {
  const now = nowIso();
  await db
    .update(users)
    .set({ passwordChangedAt: now, updatedAt: now })
    .where(eq(users.id, userId));
}

/**
 * Drop a user's password: the hash on the user row and the Better Auth credential account that
 * mirrors it, leaving their linked providers as the only way in. Callers must have checked that at
 * least one provider is linked - this does not, so it can never be the reason a check was skipped.
 */
export async function removeUserPassword(userId: number): Promise<void> {
  assertNotDemoAdmin(userId);
  const now = nowIso();
  await db
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
  await db
    .update(users)
    .set({ passwordHash: null, passwordChangedAt: null, updatedAt: now })
    .where(eq(users.id, userId));
  // users.provider still says "credentials"; re-derive it from the accounts now left.
  await syncUserOAuthIdentity(userId);
}

/**
 * The OAuth identities linked to a user, from `accounts`. `users.provider`/`subject` are a cached
 * projection, so the Profile page reads here and a stale one cannot misreport it (#261).
 */
export async function listUserOAuthProviders(
  userId: number,
): Promise<Array<{ providerId: string; accountId: string }>> {
  return db
    .select({ providerId: accounts.providerId, accountId: accounts.accountId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), ne(accounts.providerId, "credential")))
    .orderBy(desc(accounts.id));
}

/**
 * Re-derive `users.provider` / `users.subject` from `accounts`, which Better Auth writes alone
 * (#261). The newest OAuth account wins; otherwise "credentials", or null with neither.
 */
export async function syncUserOAuthIdentity(userId: number): Promise<void> {
  const [oauthAccount] = await db
    .select({ providerId: accounts.providerId, accountId: accounts.accountId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), ne(accounts.providerId, "credential")))
    .orderBy(desc(accounts.id))
    .limit(1);

  const now = nowIso();
  if (oauthAccount) {
    await db
      .update(users)
      .set({
        provider: oauthAccount.providerId,
        subject: oauthAccount.accountId,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    return;
  }

  const [[credentialAccount], user] = await Promise.all([
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
      .limit(1),
    getUserById(userId),
  ]);
  const hasCredential = !!credentialAccount || !!user?.passwordHash;

  await db
    .update(users)
    .set({
      provider: hasCredential ? "credentials" : null,
      subject: null,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}

export async function listUsers(): Promise<User[]> {
  const rows = await db.query.users.findMany({
    orderBy: (table, { asc }) => asc(table.createdAt),
  });
  return rows.map(parseDbUser);
}

const ADMIN_INVARIANT_LOCK = "admin_invariant_lock";

/**
 * Whether `userId` is an active admin with no other active admin beside them. Only meaningful
 * under the admin lock: two unlocked callers removing each other would both see the other.
 */
export async function isLastActiveAdmin(userId: number): Promise<boolean> {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")));
  return admins.some((row) => row.id === userId) && admins.length === 1;
}

/**
 * Serialises every change that can remove an active admin - role, status, delete, OIDC sync -
 * so the "at least one" check and the write can't interleave with another such change.
 */
export function withAdminLock<T>(work: () => Promise<T>): Promise<T> {
  return withRowLock(ADMIN_INVARIANT_LOCK, work);
}

async function assertKeepsAnAdmin(userId: number): Promise<void> {
  if (await isLastActiveAdmin(userId)) throw domainError("lastActiveAdmin", {}, { status: 409 });
}

export async function updateUserRole(userId: number, role: User["role"]): Promise<User | null> {
  if (role !== "admin") assertNotDemoAdmin(userId);
  return withAdminLock(async () => {
    if (role !== "admin") await assertKeepsAnAdmin(userId);
    const [updated] = await db
      .update(users)
      .set({ role, updatedAt: nowIso() })
      .where(eq(users.id, userId))
      .returning();
    return updated ? parseDbUser(updated) : null;
  });
}

export async function updateUserStatus(userId: number, status: string): Promise<User | null> {
  if (status !== "active") assertNotDemoAdmin(userId);
  const updated = await withAdminLock(async () => {
    if (status !== "active") await assertKeepsAnAdmin(userId);
    const [row] = await db
      .update(users)
      .set({ status, updatedAt: nowIso() })
      .where(eq(users.id, userId))
      .returning();
    return row;
  });

  if (status !== "active") {
    await deleteUserForwardAuthSessions(userId);
  }

  return updated ? parseDbUser(updated) : null;
}

export async function deleteUser(userId: number): Promise<void> {
  assertNotDemoAdmin(userId);
  await withAdminLock(async () => {
    await assertKeepsAnAdmin(userId);
    await db.delete(users).where(eq(users.id, userId));
  });
}

/**
 * The most recent session start per user, standing in for "last signed in". Expired sessions are
 * deleted, so the list says "no active session" rather than "never".
 */
export async function lastSessionByUser(): Promise<Map<number, string>> {
  const rows = await db
    .select({ userId: sessions.userId, lastSeen: max(sessions.createdAt) })
    .from(sessions)
    .groupBy(sessions.userId);
  const byUser = new Map<number, string>();
  for (const row of rows) {
    const iso = toIso(row.lastSeen);
    if (iso) byUser.set(row.userId, iso);
  }
  return byUser;
}

/**
 * The users who have a login password. A credential account is the test, not users.passwordHash:
 * a self-registered user's password lives on the account Better Auth created, and the hash column
 * on their user row is never filled in.
 */
export async function usersWithPassword(): Promise<Set<number>> {
  const rows = await db
    .selectDistinct({ userId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.providerId, "credential"));
  return new Set(rows.map((row) => row.userId));
}
