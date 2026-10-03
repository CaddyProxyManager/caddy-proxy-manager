import db, { nowIso, runInTransaction, toIso } from "../db";
import type { AppRole } from "../oidc-groups";
import { users, accounts, sessions } from "../db/schema";
import { and, count, desc, eq, isNotNull, isNull, max, ne } from "drizzle-orm";
import { uuidv7 } from "../uuidv7";
import { deleteUserForwardAuthSessions } from "./forward-auth";
import { isDemoAdmin } from "../demo-mode";
import { domainError } from "../domain-error";
import { withRowLock } from "../db-claim";
import { resetAccountFailuresFor } from "../rate-limit";
import type { AccountDisabledReason } from "../notifications/account-owner";
import {
  isUsableSignInUsername,
  LOGIN_USERNAME_MAX_LENGTH,
  LOGIN_USERNAME_MIN_LENGTH,
} from "../login-username";
import {
  isSignInNameTaken,
  lowercasesIntoAscii,
  ownEmailUsername,
  PORTAL_EMAIL_DOMAIN,
  signInEmailConflict,
} from "../sign-in-names";

/** See isDemoAdmin: the shared demo account keeps its password, its role and its access. */
function assertNotDemoAdmin(userId: number): void {
  if (isDemoAdmin(userId)) throw domainError("demoAdminProtected", {}, { status: 403 });
}

export type User = {
  id: number;
  email: string;
  name: string | null;
  /** The login page's username, or null. Only the account's own email or an admin's choice. */
  username: string | null;
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
    username: user.username,
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

const SIGN_IN_NAMES_LOCK = "sign_in_names_lock";

/** Every check-then-write of a username or email, so two writers cannot both pass the check. */
function withSignInNamesLock<T>(work: () => Promise<T>): Promise<T> {
  return withRowLock(SIGN_IN_NAMES_LOCK, work);
}

/** Trimmed and lowercased; refused when lowercasing would make it another address. */
function storedEmail(email: string): string {
  if (lowercasesIntoAscii(email)) {
    throw domainError("emailLowercasesIntoAscii", {}, { status: 400 });
  }
  const stored = email.trim().toLowerCase();
  if (!stored) throw domainError("emailRequired", {}, { status: 400 });
  return stored;
}

async function assertEmailAvailable(userId: number | null, email: string): Promise<void> {
  const conflict = await signInEmailConflict(db, userId, email);
  if (conflict) throw domainError(conflict, {}, { status: 400 });
}

/** An administrator's chosen username, trimmed; refused unless usable and nobody else's. */
async function checkChosenUsername(userId: number | null, input: string): Promise<string> {
  const username = input.trim();
  if (!isUsableSignInUsername(username)) {
    throw domainError(
      "signInUsernameInvalid",
      { min: LOGIN_USERNAME_MIN_LENGTH, max: LOGIN_USERNAME_MAX_LENGTH },
      { status: 400 },
    );
  }
  if (await isSignInNameTaken(db, userId, username)) {
    throw domainError("signInNameTaken", {}, { status: 400 });
  }
  return username;
}

export async function createUser(data: {
  email: string;
  name?: string | null;
  role?: User["role"];
  provider: string;
  subject: string;
  avatarUrl?: string | null;
  passwordHash?: string | null;
  /** Checked as an administrator's choice; without one, see ownEmailUsername. */
  username?: string | null;
  displayUsername?: string | null;
}): Promise<User> {
  const role = data.role ?? "user";
  const email = storedEmail(data.email);
  const provider = data.provider === "credential" ? "credentials" : data.provider;

  const created = await withSignInNamesLock(async () => {
    await assertEmailAvailable(null, email);
    const username =
      data.username != null
        ? await checkChosenUsername(null, data.username)
        : await ownEmailUsername(db, null, email);
    const displayUsername = data.displayUsername ?? data.name ?? email.split("@")[0];
    const now = nowIso();

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
  });
  if (role === "admin") await reportNewAdmin(created, false);
  return created;
}

/**
 * Tells the other administrators, except for the first one setup creates. Imported lazily: the
 * notifications reach the settings, which import other models.
 */
export async function reportNewAdmin(
  user: { id: number; email: string },
  promoted: boolean,
): Promise<void> {
  try {
    const [{ isSetupCompleted }, { notify }] = await Promise.all([
      import("../setup"),
      import("../notifications"),
    ]);
    if (!(await isSetupCompleted())) return;
    await notify(`admin-added:${user.id}`, { kind: "adminAdded", email: user.email, promoted });
  } catch (error) {
    console.error("Failed to report a new administrator:", error);
  }
}

type ProfileChanges = { email?: string; name?: string | null; avatarUrl?: string | null };
type AccountChanges = ProfileChanges & { username?: string };

/**
 * One update, after every check: a refused email or username leaves every field unchanged. The
 * username the user already has is no change, so other fields stay editable around an unusable one.
 */
async function writeUserChanges(
  userId: number,
  data: AccountChanges,
): Promise<{ row: DbUser; previousUsername: string | null } | null> {
  const [current] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!current) return null;
  const email = data.email === undefined ? current.email : storedEmail(data.email);
  if (email !== current.email.toLowerCase()) await assertEmailAvailable(userId, email);
  const username =
    data.username !== undefined && data.username.trim() !== (current.username ?? "")
      ? await checkChosenUsername(userId, data.username)
      : null;

  const [row] = await db
    .update(users)
    .set({
      email,
      name: data.name ?? current.name,
      // An explicit null removes the icon (falling back to Gravatar or the initial); `??` would
      // make "remove profile picture" a silent no-op.
      avatarUrl: data.avatarUrl === undefined ? current.avatarUrl : data.avatarUrl,
      // displayUsername follows, as Better Auth stores it when a username changes.
      ...(username === null ? {} : { username, displayUsername: username }),
      updatedAt: nowIso(),
    })
    .where(eq(users.id, userId))
    .returning();
  return row ? { row, previousUsername: current.username } : null;
}

function writeUserChangesLocked(userId: number, data: AccountChanges) {
  // Only an email or username can collide; an avatar or name change needs no lock.
  return data.email === undefined && data.username === undefined
    ? writeUserChanges(userId, data)
    : withSignInNamesLock(() => writeUserChanges(userId, data));
}

/** Email, name and avatar. The username stays whatever the new email: only an admin changes it. */
export async function updateUserProfile(
  userId: number,
  data: ProfileChanges,
): Promise<User | null> {
  const profile = { email: data.email, name: data.name, avatarUrl: data.avatarUrl };
  const result = await writeUserChangesLocked(userId, profile);
  return result ? parseDbUser(result.row) : null;
}

/** An administrator's edit: the profile fields plus the sign-in username, all or nothing. */
export async function updateUserAccount(
  userId: number,
  data: AccountChanges,
): Promise<{ user: User; previousUsername: string | null } | null> {
  const result = await writeUserChangesLocked(userId, data);
  return result
    ? { user: parseDbUser(result.row), previousUsername: result.previousUsername }
    : null;
}

/**
 * Writes the hash to the user row and to the credential account the login page checks, creating
 * that account for an OAuth-only user. A user without a usable username gets their own email as
 * one when ownEmailUsername allows, so unlinking OAuth afterwards cannot lock them out.
 */
export async function updateUserPassword(userId: number, passwordHash: string): Promise<void> {
  assertNotDemoAdmin(userId);
  await withSignInNamesLock(async () => {
    const [user] = await db
      .select({
        email: users.email,
        name: users.name,
        username: users.username,
        displayUsername: users.displayUsername,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return;
    const username = isUsableSignInUsername(user.username)
      ? null
      : await ownEmailUsername(db, userId, user.email);
    const [credential] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
      .limit(1);

    const now = nowIso();
    await runInTransaction((tx) => [
      tx
        .update(users)
        .set({
          passwordHash,
          passwordChangedAt: now,
          ...(username
            ? {
                username,
                displayUsername: user.displayUsername ?? user.name ?? username.split("@")[0],
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(users.id, userId)),
      credential
        ? tx
            .update(accounts)
            .set({ password: passwordHash, updatedAt: now })
            .where(eq(accounts.id, credential.id))
        : tx.insert(accounts).values({
            userId,
            accountId: userId.toString(),
            providerId: "credential",
            password: passwordHash,
            createdAt: now,
            updatedAt: now,
          }),
    ]);
  });
}

/**
 * The password hash, or null for an OAuth-only account. Self-registration writes it only to the
 * credential account, so users.passwordHash alone would skip the current-password check.
 */
export async function getUserPasswordHash(
  user: Pick<User, "id" | "passwordHash">,
): Promise<string | null> {
  if (user.passwordHash) return user.passwordHash;
  const [credential] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, user.id),
        eq(accounts.providerId, "credential"),
        isNotNull(accounts.password),
      ),
    )
    .limit(1);
  return credential?.password || null;
}

/**
 * The username the login page signs this user in with, or null when it cannot without OAuth: it
 * needs a usable username and a password on the credential account.
 */
export async function getPasswordSignInUsername(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ username: users.username })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.providerId, "credential"),
        isNotNull(accounts.password),
        ne(accounts.password, ""),
      ),
    )
    .limit(1);
  return isUsableSignInUsername(row?.username) ? row.username : null;
}

/**
 * CPM's sign-in name rules for a user Better Auth is about to create. An IdP can assert any
 * "email": one without an '@', or a @localhost portal name, would claim a name only an admin gives
 * out. Self-registration gets its own email as username when it qualifies; OAuth gets none.
 */
export async function applySignInNameRules<T extends Record<string, unknown>>(
  user: T,
  selfRegistered: boolean,
): Promise<T & { username: string | null }> {
  const email = typeof user.email === "string" ? user.email : "";
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.toLowerCase().endsWith(PORTAL_EMAIL_DOMAIN)) {
    throw domainError("emailNotAllowed", {}, { status: 400 });
  }
  await assertEmailAvailable(null, email);
  if (!selfRegistered) return { ...user, username: null };
  const username = await ownEmailUsername(db, null, email);
  return { ...user, username, displayUsername: username };
}

/**
 * After Better Auth's insert: an admin may have given the checked name to someone else in between
 * (the column has no unique index). The new account loses it - it was only the automatic one.
 */
export async function releaseContestedSignInUsername(userId: number): Promise<void> {
  await withSignInNamesLock(async () => {
    const [row] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.username) return;
    if (!(await isSignInNameTaken(db, userId, row.username.toLowerCase()))) return;
    await db.update(users).set({ username: null, updatedAt: nowIso() }).where(eq(users.id, userId));
  });
}

export type SignInUsernameReview = {
  userId: number;
  username: string;
  reason: "shared" | "other-address";
};

/**
 * Stored usernames for an administrator to check; read-only, for startup. "shared": another
 * account holds the name too. "other-address": an email other than the account's own.
 */
export async function findSignInUsernamesToReview(): Promise<SignInUsernameReview[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, username: users.username })
    .from(users)
    .orderBy(users.id);
  const holders = new Map<string, Set<number>>();
  const hold = (name: string, userId: number) => {
    const ids = holders.get(name) ?? new Set<number>();
    ids.add(userId);
    holders.set(name, ids);
  };
  for (const row of rows) {
    const email = row.email.toLowerCase();
    hold(email, row.id);
    if (email.endsWith(PORTAL_EMAIL_DOMAIN)) {
      hold(email.slice(0, -PORTAL_EMAIL_DOMAIN.length), row.id);
    }
    if (row.username) hold(row.username.toLowerCase(), row.id);
  }

  const review: SignInUsernameReview[] = [];
  for (const row of rows) {
    if (!row.username) continue;
    const name = row.username.toLowerCase();
    const email = row.email.toLowerCase();
    if ([...(holders.get(name) ?? [])].some((id) => id !== row.id)) {
      review.push({ userId: row.id, username: row.username, reason: "shared" });
    } else if (name.includes("@") && name !== email && name + PORTAL_EMAIL_DOMAIN !== email) {
      review.push({ userId: row.id, username: row.username, reason: "other-address" });
    }
  }
  return review;
}

/** For the container log at startup; an administrator resolves each on the Users page. */
export async function warnAboutSignInUsernamesToReview(): Promise<void> {
  for (const { userId, username, reason } of await findSignInUsernamesToReview()) {
    console.warn(
      reason === "shared"
        ? `Sign-in username ${JSON.stringify(username)} of user ${userId} is also another ` +
            "account's username, email address or forward-auth portal name; give one of them " +
            "a different username on the Users page"
        : `Sign-in username ${JSON.stringify(username)} of user ${userId} is an email address ` +
            "other than the account's own and can be somebody else's; check it on the Users page",
    );
  }
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
  let promoted = false;
  const result = await withAdminLock(async () => {
    if (role !== "admin") await assertKeepsAnAdmin(userId);
    const [before] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const [updated] = await db
      .update(users)
      .set({ role, updatedAt: nowIso() })
      .where(eq(users.id, userId))
      .returning();
    promoted = role === "admin" && before !== undefined && before.role !== "admin";
    return updated ? parseDbUser(updated) : null;
  });
  if (promoted && result) await reportNewAdmin(result, true);
  return result;
}

/** `reason` is only what the owner is told, if Settings says to tell them. */
export async function updateUserStatus(
  userId: number,
  status: string,
  reason: AccountDisabledReason = { by: "administrator" },
): Promise<User | null> {
  if (status !== "active") assertNotDemoAdmin(userId);
  let wasActive = false;
  const updated = await withAdminLock(async () => {
    if (status !== "active") await assertKeepsAnAdmin(userId);
    const [previous] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    wasActive = previous?.status === "active";
    const [row] = await db
      .update(users)
      .set({ status, updatedAt: nowIso() })
      .where(eq(users.id, userId))
      .returning();
    return row;
  });

  // CPM's routes refuse a disabled user's session, but Better Auth's own endpoints would not.
  if (status !== "active") {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await deleteUserForwardAuthSessions(userId);
  } else if (updated) {
    // Or an account auto-disabled for its failed sign-ins is disabled again by the next typo.
    resetAccountFailuresFor([updated.email, updated.username]);
  }

  // Once, on the change: disabling a disabled account tells nobody anything.
  if (updated && wasActive && status !== "active") {
    const { tellOwnerAccountDisabled } = await import("../notifications/account-owner");
    await tellOwnerAccountDisabled(parseDbUser(updated), reason);
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

/** Rows written by raw SQL (a pre-UUID database, e2e seeds) have none until this fills them. */
export async function ensureUserUuids(): Promise<number> {
  const missing = await db.select({ id: users.id }).from(users).where(isNull(users.uuid));
  for (const { id } of missing) {
    await db
      .update(users)
      .set({ uuid: uuidv7() })
      .where(and(eq(users.id, id), isNull(users.uuid)));
  }
  return missing.length;
}

/** The user's UUID, assigned now if it has none; re-read so a concurrent assignment wins. */
export async function getOrAssignUserUuid(id: number, current: string | null): Promise<string> {
  if (current) return current;
  await db
    .update(users)
    .set({ uuid: uuidv7() })
    .where(and(eq(users.id, id), isNull(users.uuid)));
  const [row] = await db.select({ uuid: users.uuid }).from(users).where(eq(users.id, id)).limit(1);
  if (!row?.uuid) throw new Error(`User ${id} has no UUID`);
  return row.uuid;
}
