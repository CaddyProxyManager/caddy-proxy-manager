/**
 * First-run setup. A real sign-in comes before any other configuration, or a bad OAuth secret is
 * found only after everything else is entered. The stage is derived from what exists, so it
 * resumes and survives the back button; only completion is stored, being otherwise invisible.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import db, { nowIso } from "./db";
import { accounts, settings, users } from "./db/schema";
import { getUserCount } from "./models/user";
import { listEnabledOAuthProviders } from "./models/oauth-providers";
import { scanForLegacyDatabases } from "./migration/legacy-database";
import { logAuditEvent } from "./audit";

/** Whether anything on this host looks like a database from before the PostgreSQL move. */
export function hasLegacyDatabase(): boolean {
  return scanForLegacyDatabases().candidates.length > 0;
}

/** Not a registry setting: the flow's own bookkeeping, not something an operator configures. */
const SETUP_COMPLETED_KEY = "setup:completed";

/** Without it the offer reappears on every request and account creation is unreachable. */
const MIGRATION_DECLINED_KEY = "setup:migration_declined";

/** The file a migration read from: the final screen offers it as a backup, and only if set. */
const MIGRATION_SOURCE_KEY = "setup:migrated_from";

export type SetupStage =
  /** A previous version's database is on this host and has not been dealt with. */
  | "migrate"
  /** Nothing to sign in with. Choose controller or agent, then create an account. */
  | "account"
  /** An account exists but this browser has not proved it works. */
  | "verify"
  /** Signed in, and the rest of the configuration has not been saved yet. */
  | "settings"
  /** Setup is finished; the app runs normally. */
  | "complete";

export type SetupState = {
  stage: SetupStage;
  /** True while the app should serve nothing but the setup flow. */
  required: boolean;
};

async function isFlagSet(key: string): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value === "true";
}

async function setFlag(key: string): Promise<void> {
  const now = nowIso();
  await db
    .insert(settings)
    .values({ key, value: "true", updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: "true", updatedAt: now } });
}

/** Remember which file was migrated, for the summary and the backup download. */
export async function recordMigrationSource(path: string): Promise<void> {
  const now = nowIso();
  await db
    .insert(settings)
    .values({ key: MIGRATION_SOURCE_KEY, value: path, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: path, updatedAt: now } });
}

/** The migrated file's path, or null when this deployment did not migrate. */
export async function getMigrationSource(): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, MIGRATION_SOURCE_KEY))
    .limit(1);
  return row?.value ?? null;
}

/**
 * Once an import brings accounts, restarting is no longer open to anyone, so the importing browser
 * gets this single-use token. Stored hashed; the plaintext is only in the migrate response.
 */
const RESTART_TOKEN_KEY = "setup:restart_token";
const RESTART_TOKEN_TTL_MS = 15 * 60 * 1000;

/** In the database because it has to outlive the exit it allows. */
const RESTART_REQUESTED_KEY = "setup:restart_requested_at";
export const RESTART_COOLDOWN_MS = 60 * 1000;

function hashRestartToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueRestartToken(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const value = JSON.stringify({
    hash: hashRestartToken(token),
    expiresAt: Date.now() + RESTART_TOKEN_TTL_MS,
  });
  const now = nowIso();
  await db
    .insert(settings)
    .values({ key: RESTART_TOKEN_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  return token;
}

/** The stored token row, when `token` is the unexpired one it was issued for. */
async function matchRestartToken(token: string | null): Promise<{ value: string } | null> {
  if (!token) return null;
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, RESTART_TOKEN_KEY))
    .limit(1);
  if (!row) return null;

  let stored: { hash?: unknown; expiresAt?: unknown };
  try {
    stored = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof stored.hash !== "string" || typeof stored.expiresAt !== "number") return null;
  if (stored.expiresAt <= Date.now()) return null;

  const presented = Buffer.from(hashRestartToken(token), "hex");
  const expected = Buffer.from(stored.hash, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return row;
}

/** Leaves it unspent, for a caller that may still refuse: the token buys only one restart. */
export async function restartTokenMatches(token: string | null): Promise<boolean> {
  return (await matchRestartToken(token)) !== null;
}

/** Whether `token` is the unexpired one issued, spending it if so. */
export async function consumeRestartToken(token: string | null): Promise<boolean> {
  const row = await matchRestartToken(token);
  if (!row) return false;

  // Deleted by value, so two requests racing with the same token cannot both spend it.
  const spent = await db
    .delete(settings)
    .where(and(eq(settings.key, RESTART_TOKEN_KEY), eq(settings.value, row.value)))
    .returning({ key: settings.key });
  return spent.length > 0;
}

/** Atomic: the stamp moves only when older than the cooldown. ISO timestamps compare as text. */
export async function claimRestartSlot(
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const stamp = new Date(now).toISOString();
  const cutoff = new Date(now - RESTART_COOLDOWN_MS).toISOString();
  const claimed = await db
    .insert(settings)
    .values({ key: RESTART_REQUESTED_KEY, value: stamp, updatedAt: stamp })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stamp, updatedAt: stamp },
      setWhere: lt(settings.value, cutoff),
    })
    .returning({ key: settings.key });
  if (claimed.length > 0) return { ok: true };

  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, RESTART_REQUESTED_KEY))
    .limit(1);
  const parsed = row ? Date.parse(row.value) : Number.NaN;
  if (row && !Number.isFinite(parsed)) {
    // A corrupt stamp never compares older, refusing every restart with a NaN Retry-After.
    // Replace it, still atomically.
    const repaired = await db
      .update(settings)
      .set({ value: stamp, updatedAt: stamp })
      .where(and(eq(settings.key, RESTART_REQUESTED_KEY), eq(settings.value, row.value)))
      .returning({ key: settings.key });
    if (repaired.length > 0) return { ok: true };
  }
  const last = Number.isFinite(parsed) ? parsed : now;
  return { ok: false, retryAfterMs: Math.max(0, last + RESTART_COOLDOWN_MS - now) };
}

/** Record that the operator chose not to migrate, so the offer is not made again. */
export async function declineMigration(): Promise<void> {
  await setFlag(MIGRATION_DECLINED_KEY);
}

export async function isMigrationDeclined(): Promise<boolean> {
  return isFlagSet(MIGRATION_DECLINED_KEY);
}

/**
 * Declined or migrated. Checked explicitly because a migration can leave the accounts behind,
 * and "can anything sign in" would then offer the same file again.
 */
export async function isMigrationSettled(): Promise<boolean> {
  if (await isMigrationDeclined()) return true;
  return (await getMigrationSource()) !== null;
}

export async function isSetupCompleted(): Promise<boolean> {
  return isFlagSet(SETUP_COMPLETED_KEY);
}

export async function markSetupCompleted(): Promise<void> {
  await setFlag(SETUP_COMPLETED_KEY);
}

/** A local account or an enabled OAuth provider, checked regardless of mode. */
export async function hasAnySignIn(): Promise<boolean> {
  if ((await getUserCount()) > 0) return true;
  return (await listEnabledOAuthProviders()).length > 0;
}

/**
 * Whoever completes setup via OAuth becomes admin: `enforceSafeUserDefaults` pins federated
 * sign-ups to "user", so an IdP-only setup could never finish. Guards: setup unfinished, no admin
 * yet, and a federated account - a local sign-in here is always `createFirstAdmin`'s admin.
 */
export async function promoteFirstSetupAdmin(userId: number): Promise<boolean> {
  if (!Number.isFinite(userId)) return false;
  if (await isSetupCompleted()) return false;

  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")));
  if (admins.length > 0) return false;

  const linked = await db
    .select({ providerId: accounts.providerId })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  if (!linked.some((account) => account.providerId !== "credential")) return false;

  const [promoted] = await db
    .update(users)
    .set({ role: "admin", updatedAt: nowIso() })
    .where(eq(users.id, userId))
    .returning();
  if (!promoted) return false;

  await logAuditEvent({
    userId,
    action: "setup_first_admin",
    entityType: "user",
    entityId: userId,
    summary: `User ${userId} became the first administrator by signing in during setup`,
  });
  console.log(`Setup completed by user ${userId} - promoted to administrator`);
  return true;
}

/** `signedIn` is passed in: the proxy, components and route handlers each read it differently. */
export async function getSetupState(signedIn: boolean): Promise<SetupState> {
  if (await isSetupCompleted()) {
    return { stage: "complete", required: false };
  }

  if (!(await hasAnySignIn())) {
    // Before account creation: an operator with an old database wants its accounts.
    if (!(await isMigrationSettled()) && hasLegacyDatabase()) {
      return { stage: "migrate", required: true };
    }
    return { stage: "account", required: true };
  }

  return signedIn ? { stage: "settings", required: true } : { stage: "verify", required: true };
}

/** Where each stage lives, for the redirects the proxy and the pages perform. */
export const SETUP_PATHS: Record<SetupStage, string> = {
  migrate: "/setup/migrate",
  account: "/setup",
  verify: "/login",
  settings: "/setup/settings",
  complete: "/",
};

/**
 * "Predates the setup flow". The environment, not "any users": someone halfway through setup has
 * an account, and a restart must not mark them finished.
 */
function environmentConfiguresSignIn(): boolean {
  const hasAdminCredentials =
    (process.env.ADMIN_USERNAME ?? "").trim() !== "" &&
    (process.env.ADMIN_PASSWORD ?? "").trim() !== "";
  return hasAdminCredentials || process.env.OAUTH_ENABLED === "true";
}

/** Called once at startup, after the admin seed. */
export async function backfillSetupCompletion(): Promise<void> {
  if (await isSetupCompleted()) return;
  if (!environmentConfiguresSignIn()) return;
  if (!(await hasAnySignIn())) return;

  await markSetupCompleted();
  console.log("Sign-in is configured from the environment - first-run setup marked complete");
}
