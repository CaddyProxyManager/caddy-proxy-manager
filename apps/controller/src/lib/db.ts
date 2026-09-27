/**
 * The database handle (connection in ./db/connection.ts) plus one-time data migrations,
 * top-level-awaited so no route handler can observe a half-migrated database.
 */
import { eq, ne, and, isNull, desc } from "drizzle-orm";
import * as schema from "./db/schema";
import { db, isEphemeral, runSchemaMigrations } from "./db/connection";
import { encryptSecret, isEncryptedSecret } from "./secret";

export { db, client, runInTransaction } from "./db/connection";
export type { Db } from "./db/connection";

try {
  await runSchemaMigrations();
} catch (error) {
  console.error("Failed to run database migrations:", error);
  // Parallel build workers share the build database; everywhere else fails closed on errors.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    console.warn("Continuing despite migration error during build phase");
  } else {
    throw error;
  }
}

/** Populates `accounts` from users' provider/subject. Idempotent via a settings flag. */
async function runBetterAuthDataMigration() {
  if (isEphemeral) return;

  const { settings, users, accounts } = schema;

  const [flag] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "better_auth_migrated"))
    .limit(1);
  if (flag) return;

  const now = new Date().toISOString();
  const oauthUsers = await db.select().from(users).where(ne(users.provider, "credentials"));
  for (const user of oauthUsers) {
    if (!user.provider || !user.subject) continue;
    const [existing] = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.providerId, user.provider),
          eq(accounts.accountId, user.subject),
        ),
      )
      .limit(1);
    if (!existing) {
      await db.insert(accounts).values({
        userId: user.id,
        accountId: user.subject,
        providerId: user.provider,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
    }
  }

  const credentialUsers = await db.select().from(users).where(eq(users.provider, "credentials"));
  for (const user of credentialUsers) {
    const [existing] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")))
      .limit(1);
    if (!existing) {
      await db.insert(accounts).values({
        userId: user.id,
        accountId: user.id.toString(),
        providerId: "credential",
        password: user.passwordHash,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
    }
  }

  // Derived from the email prefix.
  const usersWithoutUsername = await db.select().from(users).where(isNull(users.username));
  for (const user of usersWithoutUsername) {
    const usernameFromEmail = user.email.toLowerCase();
    const displayUsername = user.email.split("@")[0] || user.email;
    await db
      .update(users)
      .set({
        username: usernameFromEmail,
        displayUsername,
      })
      .where(eq(users.id, user.id));
  }

  await db.insert(settings).values({ key: "better_auth_migrated", value: "true", updatedAt: now });
  console.log("Better Auth data migration complete: populated accounts table");
}

/** Raw Drizzle: this runs at module load. */
async function runEnvProviderSync() {
  if (isEphemeral) return;

  // Lazy, to avoid a circular import at module load.
  let config: {
    oauth: {
      enabled: boolean;
      providerName: string;
      clientId: string | null;
      clientSecret: string | null;
      issuer: string | null;
      authorizationUrl: string | null;
      tokenUrl: string | null;
      userinfoUrl: string | null;
      allowAutoLinking: boolean;
      scopes: string | null;
      groupsClaim: string | null;
      groupPrefix: string | null;
      roleMappingEnabled: boolean;
      adminGroup: string | null;
      operatorGroup: string | null;
      userGroup: string | null;
      viewerGroup: string | null;
      defaultRole: string | null;
      syncGroups: boolean;
    };
  };
  try {
    config = require("./config").config;
  } catch {
    return;
  }

  if (!config.oauth.enabled || !config.oauth.clientId || !config.oauth.clientSecret) return;

  const { oauthProviders } = schema;
  let encryptSecret: (v: string) => string;
  try {
    encryptSecret = require("./secret").encryptSecret;
  } catch (e) {
    console.error(
      "CRITICAL: Failed to load encryption module, refusing to store plaintext secrets:",
      e,
    );
    return;
  }

  const name = config.oauth.providerName;
  // A slug, so the OAuth callback URL is predictable.
  const providerId =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "oauth";
  const [existing] = await db
    .select()
    .from(oauthProviders)
    .where(eq(oauthProviders.name, name))
    .limit(1);

  const validRoles = new Set(["admin", "user", "viewer"]);
  const defaultRole =
    config.oauth.defaultRole && validRoles.has(config.oauth.defaultRole)
      ? config.oauth.defaultRole
      : "user";
  const groupMapping = {
    groupsClaim: config.oauth.groupsClaim ?? "groups",
    groupPrefix: config.oauth.groupPrefix ?? null,
    roleMappingEnabled: config.oauth.roleMappingEnabled,
    adminGroup: config.oauth.adminGroup ?? null,
    operatorGroup: config.oauth.operatorGroup ?? null,
    userGroup: config.oauth.userGroup ?? null,
    viewerGroup: config.oauth.viewerGroup ?? null,
    defaultRole,
    syncGroups: config.oauth.syncGroups,
  };

  const now = new Date().toISOString();
  if (existing && existing.source === "env") {
    await db
      .update(oauthProviders)
      .set({
        clientId: encryptSecret(config.oauth.clientId),
        clientSecret: encryptSecret(config.oauth.clientSecret),
        issuer: config.oauth.issuer ?? null,
        authorizationUrl: config.oauth.authorizationUrl ?? null,
        tokenUrl: config.oauth.tokenUrl ?? null,
        userinfoUrl: config.oauth.userinfoUrl ?? null,
        scopes: config.oauth.scopes ?? existing.scopes,
        autoLink: config.oauth.allowAutoLinking,
        ...groupMapping,
        updatedAt: now,
      })
      .where(eq(oauthProviders.id, existing.id));
  } else if (!existing) {
    await db.insert(oauthProviders).values({
      id: providerId,
      name,
      type: "oidc",
      clientId: encryptSecret(config.oauth.clientId),
      clientSecret: encryptSecret(config.oauth.clientSecret),
      issuer: config.oauth.issuer ?? null,
      authorizationUrl: config.oauth.authorizationUrl ?? null,
      tokenUrl: config.oauth.tokenUrl ?? null,
      userinfoUrl: config.oauth.userinfoUrl ?? null,
      scopes: config.oauth.scopes ?? "openid email profile",
      autoLink: config.oauth.allowAutoLinking,
      ...groupMapping,
      enabled: true,
      source: "env",
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Synced OAuth provider from env: ${name}`);
  }
}

/** One-time migration: legacy Cloudflare DNS settings → the generic dns_provider format. */
async function runCloudflareToProviderMigration() {
  if (isEphemeral) return;

  const { settings: settingsTable } = schema;

  const [flag] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "dns_provider_migrated"))
    .limit(1);
  if (flag) return;

  // The user already configured the new format.
  const [existing] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "dns_provider"))
    .limit(1);
  if (existing) {
    const now = new Date().toISOString();
    await db
      .insert(settingsTable)
      .values({ key: "dns_provider_migrated", value: "true", updatedAt: now });
    return;
  }

  const [cfRow] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "cloudflare"))
    .limit(1);
  if (!cfRow) {
    const now = new Date().toISOString();
    await db
      .insert(settingsTable)
      .values({ key: "dns_provider_migrated", value: "true", updatedAt: now });
    return;
  }

  try {
    const cf = JSON.parse(cfRow.value) as {
      apiToken?: string;
      zoneId?: string;
      accountId?: string;
    };
    if (cf.apiToken) {
      const now = new Date().toISOString();
      // The legacy row may predate encryption; the provider row must not carry the token in clear.
      const apiToken = isEncryptedSecret(cf.apiToken) ? cf.apiToken : encryptSecret(cf.apiToken);
      const newSetting = {
        providers: { cloudflare: { api_token: apiToken } },
        default: "cloudflare",
      };
      await db
        .insert(settingsTable)
        .values({ key: "dns_provider", value: JSON.stringify(newSetting), updatedAt: now });
      console.log("Migrated legacy Cloudflare DNS settings to dns_provider format");
    }
  } catch (e) {
    console.warn("Failed to parse legacy cloudflare setting during migration:", e);
  }

  const now = new Date().toISOString();
  await db
    .insert(settingsTable)
    .values({ key: "dns_provider_migrated", value: "true", updatedAt: now });
}

/**
 * One-time repair (#261): re-derive `users.provider`/`subject` from `accounts`. Mirrors
 * syncUserOAuthIdentity() in models/user, which imports this module.
 */
async function runOAuthIdentityRepair() {
  if (isEphemeral) return;

  const { settings, users, accounts } = schema;

  const [flag] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "oauth_identity_sync_repaired"))
    .limit(1);
  if (flag) return;

  const allUsers = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users);
  for (const user of allUsers) {
    const now = new Date().toISOString();

    const [oauthAccount] = await db
      .select({ providerId: accounts.providerId, accountId: accounts.accountId })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), ne(accounts.providerId, "credential")))
      .orderBy(desc(accounts.id))
      .limit(1);

    if (oauthAccount) {
      await db
        .update(users)
        .set({
          provider: oauthAccount.providerId,
          subject: oauthAccount.accountId,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      continue;
    }

    const [credentialAccount] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")))
      .limit(1);
    const hasCredential = !!credentialAccount || !!user.passwordHash;

    await db
      .update(users)
      .set({ provider: hasCredential ? "credentials" : null, subject: null, updatedAt: now })
      .where(eq(users.id, user.id));
  }

  await db.insert(settings).values({
    key: "oauth_identity_sync_repaired",
    value: "true",
    updatedAt: new Date().toISOString(),
  });
  console.log("OAuth identity repair complete: users.provider/subject re-derived from accounts");
}

try {
  await runBetterAuthDataMigration();
  await runEnvProviderSync();
  await runCloudflareToProviderMigration();
  await runOAuthIdentityRepair();
} catch (error) {
  console.warn("Better Auth data migration warning:", error);
}

export { schema };
export default db;

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
