import { hashPassword, verifyPassword } from "./password";
import db, { nowIso, runInTransaction } from "./db";
import { localUsersDisabled } from "./auth-policy";
import { config } from "./config";
import { isDemoMode, SEEDED_ADMIN_ID } from "./demo-mode";
import {
  accounts,
  forwardAuthSessions,
  schemaDialect,
  sessions,
  settings,
  users,
} from "./db/schema";
import { and, eq, sql } from "drizzle-orm";
import { isSignInNameTaken, signInEmailConflict } from "./sign-in-names";

/**
 * ADMIN_USERNAME and a hash of the ADMIN_PASSWORD last applied. The environment is applied only
 * when it changes, or a password changed in the UI would revert on every restart.
 */
const ADMIN_ENV_MARKER_KEY = "admin_env_credentials_fingerprint";

type AdminEnvMarker = { v: 2; username: string; passwordHash: string };

/** The documented example passwords: an admin still holding one gets the environment's. */
const KNOWN_PUBLIC_PASSWORDS = ["admin", "Your-Secure-P@ssw0rd-Here!", "YourStr0ng-P@ssw0rd123!"];

async function getAdminEnvMarker(): Promise<AdminEnvMarker | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, ADMIN_ENV_MARKER_KEY))
    .limit(1);
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Partial<AdminEnvMarker> | null;
    if (
      value?.v === 2 &&
      typeof value.username === "string" &&
      typeof value.passwordHash === "string"
    ) {
      return { v: 2, username: value.username, passwordHash: value.passwordHash };
    }
  } catch {
    // Not a marker.
  }
  return null;
}

async function storeAdminEnvMarker(username: string, passwordHash: string): Promise<void> {
  const now = nowIso();
  const value = JSON.stringify({ v: 2, username, passwordHash } satisfies AdminEnvMarker);
  await db
    .insert(settings)
    .values({ key: ADMIN_ENV_MARKER_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

async function isKnownPublicPassword(hash: string): Promise<boolean> {
  for (const candidate of KNOWN_PUBLIC_PASSWORDS) {
    if (await verifyPassword(candidate, hash)) return true;
  }
  return false;
}

/** Nothing is written when this throws, so the next start tries again. */
async function assertAdminIdentityAvailable(
  adminId: number,
  adminUsername: string,
  identity: { username: string; email: string },
): Promise<void> {
  if (
    (await isSignInNameTaken(db, adminId, identity.username)) ||
    (await signInEmailConflict(db, adminId, identity.email))
  ) {
    throw new Error(
      `ADMIN_USERNAME ${JSON.stringify(adminUsername)} is not applied: another account already ` +
        "signs in with it or has it as its email address. Give that account a different username " +
        "or email address on the Users page, or choose another ADMIN_USERNAME.",
    );
  }
}

async function credentialAccount(userId: number) {
  const [row] = await db
    .select({ id: accounts.id, password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);
  return row ?? null;
}

/** Ensures the env-configured admin user exists. Called at startup. */
export async function ensureAdminUser(): Promise<void> {
  // OIDC-only: no local accounts, so no admin to seed; roles come from the IdP's groups.
  if (await localUsersDisabled()) {
    console.log("Local user management is disabled - skipping admin user seed");
    return;
  }

  const adminUsername = config.adminUsername;
  const adminPassword = config.adminPassword;
  if (!adminUsername || !adminPassword) {
    console.warn("Admin credentials are not configured - skipping admin user seed");
    return;
  }

  const adminId = SEEDED_ADMIN_ID; // Must match the hardcoded ID in auth.ts
  const identity = {
    email: `${adminUsername}@localhost`,
    subject: adminUsername,
    username: adminUsername.toLowerCase(),
    displayUsername: adminUsername,
  };
  // Every demo visitor sees this name; outside a demo it is only set when the row is created.
  const demoName = isDemoMode() ? "Demo Admin" : null;

  const existingUser = await db.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, adminId),
  });

  if (!existingUser) {
    await assertAdminIdentityAvailable(adminId, adminUsername, identity);
    const passwordHash = await hashPassword(adminPassword);
    const now = nowIso();
    await db.insert(users).values({
      id: adminId,
      ...identity,
      name: demoName ?? adminUsername,
      passwordHash,
      passwordChangedAt: now,
      role: "admin",
      provider: "credentials",
      avatarUrl: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await syncUserIdSequence();
    await ensureCredentialAccount(adminId, passwordHash);
    await storeAdminEnvMarker(adminUsername, passwordHash);
    console.log(`Created admin user: ${adminUsername}`);
    return;
  }

  const credential = await credentialAccount(adminId);
  const storedHash = existingUser.passwordHash ?? credential?.password ?? null;
  const envMatchesStored = !!storedHash && (await verifyPassword(adminPassword, storedHash));
  const usernameChanged = existingUser.username !== identity.username;

  const marker = await getAdminEnvMarker();
  let applyEnv: boolean;
  if (marker) {
    applyEnv =
      marker.username !== adminUsername ||
      !(await verifyPassword(adminPassword, marker.passwordHash));
  } else if (!storedHash || envMatchesStored || (await isKnownPublicPassword(storedHash))) {
    // First start since the marker: until then every start applied the environment.
    applyEnv = true;
  } else {
    applyEnv = false;
    console.warn(
      "ADMIN_PASSWORD differs from the stored admin password; keeping the stored password because " +
        "it was probably changed in the UI. Change ADMIN_PASSWORD again and restart to force it.",
    );
  }

  // Without a marker ADMIN_USERNAME was applied on every start, so a changed one still is.
  const appliesIdentity = applyEnv || (!marker && usernameChanged);
  if (appliesIdentity && (usernameChanged || existingUser.email !== identity.email)) {
    await assertAdminIdentityAvailable(adminId, adminUsername, identity);
  }

  const now = nowIso();
  if (applyEnv) {
    const passwordChanged = !envMatchesStored;
    const passwordHash =
      storedHash && !passwordChanged ? storedHash : await hashPassword(adminPassword);
    // Changed credentials are the documented recovery path, so they re-enable the admin too.
    const envChanged = marker !== null || passwordChanged || usernameChanged;
    // One transaction: the password never changes without ending the old one's sessions.
    await runInTransaction((tx) => [
      tx
        .update(users)
        .set({
          ...identity,
          ...(demoName ? { name: demoName } : {}),
          passwordHash,
          ...(passwordChanged ? { passwordChangedAt: now } : {}),
          role: "admin",
          ...(envChanged ? { status: "active" } : {}),
          updatedAt: now,
        })
        .where(eq(users.id, adminId)),
      credential
        ? tx
            .update(accounts)
            .set({ password: passwordHash, updatedAt: now })
            .where(eq(accounts.id, credential.id))
        : tx.insert(accounts).values({
            userId: adminId,
            accountId: adminId.toString(),
            providerId: "credential",
            password: passwordHash,
            createdAt: now,
            updatedAt: now,
          }),
      ...(passwordChanged
        ? [
            tx.delete(sessions).where(eq(sessions.userId, adminId)),
            tx.delete(forwardAuthSessions).where(eq(forwardAuthSessions.userId, adminId)),
          ]
        : []),
    ]);
    await storeAdminEnvMarker(adminUsername, passwordHash);
    console.log(`Applied admin credentials from environment: ${adminUsername}`);
    return;
  }

  if (appliesIdentity || (demoName && existingUser.name !== demoName)) {
    await db
      .update(users)
      .set({
        ...(appliesIdentity ? identity : {}),
        ...(demoName ? { name: demoName } : {}),
        updatedAt: now,
      })
      .where(eq(users.id, adminId));
  }
  if (storedHash && !credential) await ensureCredentialAccount(adminId, storedHash);
  if (!marker) {
    // So that changing the environment again applies it.
    await storeAdminEnvMarker(adminUsername, await hashPassword(adminPassword));
  }
  console.log(`Admin user present: ${adminUsername}`);
}

/**
 * The admin's explicit id 1 does not advance PostgreSQL's `serial`, so the next insert would get 1
 * too and fail the primary key - a bare 422 on a fresh deployment's first self-registration.
 */
async function syncUserIdSequence(): Promise<void> {
  // SQLite's AUTOINCREMENT already counts explicit ids.
  if (schemaDialect === "sqlite") return;
  await db.execute(
    sql`SELECT setval(
          pg_get_serial_sequence('users', 'id'),
          GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1)
        )`,
  );
}

/** Better Auth needs the `credential` account row. */
async function ensureCredentialAccount(userId: number, passwordHash: string): Promise<void> {
  const now = nowIso();
  const existing = await credentialAccount(userId);
  if (existing) {
    await db
      .update(accounts)
      .set({ password: passwordHash, updatedAt: now })
      .where(eq(accounts.id, existing.id));
  } else {
    await db.insert(accounts).values({
      userId,
      accountId: userId.toString(),
      providerId: "credential",
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }
}
