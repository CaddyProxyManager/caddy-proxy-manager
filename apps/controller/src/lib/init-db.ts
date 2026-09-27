import { hashPassword, verifyPassword } from "./password";
import db, { nowIso } from "./db";
import { localUsersDisabled } from "./auth-policy";
import { config } from "./config";
import { isDemoMode, SEEDED_ADMIN_ID } from "./demo-mode";
import { accounts, schemaDialect, users } from "./db/schema";
import { and, eq, sql } from "drizzle-orm";

/** Ensures the env-configured admin user exists. Called at startup. */

//Todo: this could probably be handled better, especially for the adminid.
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
  const adminEmail = `${adminUsername}@localhost`;
  const provider = "credentials";
  const subject = adminUsername;
  // Every demo visitor sees this name; outside a demo it is only set when the row is created.
  const demoName = isDemoMode() ? "Demo Admin" : null;

  const passwordHash = await hashPassword(adminPassword);

  const existingUser = await db.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, adminId),
  });

  if (existingUser) {
    const now = nowIso();
    // Rehashed every start, so only an ADMIN_PASSWORD no longer matching is worth dating.
    const passwordChanged =
      !existingUser.passwordHash ||
      !(await verifyPassword(adminPassword, existingUser.passwordHash));
    await db
      .update(users)
      .set({
        email: adminEmail,
        ...(demoName ? { name: demoName } : {}),
        subject,
        passwordHash,
        ...(passwordChanged ? { passwordChangedAt: now } : {}),
        role: "admin",
        username: adminUsername.toLowerCase(),
        displayUsername: adminUsername,
        updatedAt: now,
      })
      .where(eq(users.id, adminId));
    await ensureCredentialAccount(adminId, passwordHash);
    console.log(`Updated admin user: ${adminUsername}`);
    return;
  }

  const now = nowIso();
  await db.insert(users).values({
    id: adminId,
    email: adminEmail,
    name: demoName ?? adminUsername,
    passwordHash,
    passwordChangedAt: now,
    role: "admin",
    provider,
    subject,
    username: adminUsername.toLowerCase(),
    displayUsername: adminUsername,
    avatarUrl: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  await syncUserIdSequence();

  console.log(`Created admin user: ${adminUsername}`);

  await ensureCredentialAccount(adminId, passwordHash);
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
  const [existing] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);

  if (existing) {
    await db
      .update(accounts)
      .set({
        password: passwordHash,
        updatedAt: now,
      })
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
