/**
 * Schema repairs for a pre-3.0 SQLite file, used only by the migration flow that copies it into
 * the current database; which releases wrote which column names is not recoverable from today's
 * schema. Runs before `migrate()`. PostgreSQL never had the pre-rename history.
 */
import type { Database } from "bun:sqlite";

/** Rename a column when only the snake_case form exists. No-op if missing or already correct. */
function renameColumnIfNeeded(client: Database, table: string, from: string, to: string) {
  try {
    const cols = client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));
    if (names.has(from) && !names.has(to)) {
      client.prepare(`ALTER TABLE "${table}" RENAME COLUMN "${from}" TO "${to}"`).run();
    }
  } catch {
    // ignore
  }
}

/** Add a column if absent, checking both snake_case and camelCase so a rename isn't undone. */
function addColumnIfMissing(
  client: Database,
  table: string,
  snake: string,
  camel: string,
  definition: string,
) {
  try {
    const cols = client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
    }>;
    if (cols.length === 0) return; // table doesn't exist yet
    const names = new Set(cols.map((c) => c.name));
    if (!names.has(snake) && !names.has(camel)) {
      client.prepare(`ALTER TABLE "${table}" ADD COLUMN "${snake}" ${definition}`).run();
    }
  } catch {
    // ignore
  }
}

/**
 * Better Auth omits `id` from INSERT (generateId:"serial"), which an older `id TEXT NOT NULL`
 * rejects. Sessions are ephemeral, so the table is recreated empty.
 */
function fixSessionsSchema(client: Database) {
  try {
    const cols = client.prepare('PRAGMA table_info("sessions")').all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>;
    if (cols.length === 0) return; // table doesn't exist yet
    const idCol = cols.find((c) => c.name === "id");
    if (!idCol) return;
    if (idCol.type.toUpperCase() === "INTEGER" && idCol.pk === 1) return;
    client
      .prepare(`CREATE TABLE "sessions_patch" (
      "id"        INTEGER PRIMARY KEY AUTOINCREMENT,
      "userId"    INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "token"     TEXT NOT NULL,
      "expiresAt" TEXT NOT NULL,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    )`)
      .run();
    client.prepare('DROP TABLE "sessions"').run();
    client.prepare('ALTER TABLE "sessions_patch" RENAME TO "sessions"').run();
    client
      .prepare('CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_unique" ON "sessions" ("token")')
      .run();
    client.prepare('CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("userId")').run();
  } catch {
    // ignore
  }
}

/** The columns the rebuild below writes; kept beside it so the readiness check cannot drift. */
const REBUILT_ACCOUNT_COLUMNS = [
  "id",
  "userId",
  "accountId",
  "providerId",
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "scope",
  "password",
  "createdAt",
  "updatedAt",
] as const;

/** Same `id` problem as sessions, but accounts are durable, so rows are preserved. */
function fixAccountsSchema(client: Database) {
  try {
    const cols = client.prepare('PRAGMA table_info("accounts")').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    if (cols.length === 0) return;
    const idCol = cols.find((c) => c.name === "id");
    if (!idCol) return;
    const idIsCorrect = idCol.type.toUpperCase() === "INTEGER" && idCol.pk === 1;

    // Check the whole rebuilt shape, not just `id`: without the unique provider index nothing
    // stops two rows claiming the same (providerId, accountId).
    const columnNames = new Set(cols.map((c) => c.name));
    const hasAllColumns = REBUILT_ACCOUNT_COLUMNS.every((name) => columnNames.has(name));

    const indexes = client.prepare('PRAGMA index_list("accounts")').all() as Array<{
      name: string;
      unique: number;
    }>;
    const indexColumns = (name: string) =>
      (
        client.prepare(`PRAGMA index_info("${name}")`).all() as Array<{
          name: string;
          seqno: number;
        }>
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
        .join(",");
    const providerIndex = indexes.find(
      (index) => index.name === "accounts_provider_account_idx" && index.unique === 1,
    );
    const userIndex = indexes.find((index) => index.name === "accounts_user_idx");
    const hasProviderIndex =
      providerIndex !== undefined && indexColumns(providerIndex.name) === "providerId,accountId";
    const hasUserIndex = userIndex !== undefined && indexColumns(userIndex.name) === "userId";

    if (idIsCorrect && hasAllColumns && hasProviderIndex && hasUserIndex) {
      return;
    }

    type LegacyAccountRow = {
      id: number | string;
      userId: number;
      accountId: string;
      providerId: string;
      accessToken: string | null;
      refreshToken: string | null;
      idToken: string | null;
      accessTokenExpiresAt: string | null;
      refreshTokenExpiresAt: string | null;
      scope: string | null;
      password: string | null;
      createdAt: string;
      updatedAt: string;
    };

    const accountRows = client
      .prepare('SELECT * FROM "accounts" ORDER BY "id"')
      .all() as LegacyAccountRow[];
    // Never merge a (providerId, accountId) collision: picking either owner could be a takeover.
    const identityOwners = new Map<string, number | string>();
    for (const row of accountRows) {
      const key = JSON.stringify([row.providerId, row.accountId]);
      const existingOwner = identityOwners.get(key);
      if (existingOwner !== undefined) {
        throw new Error(
          `account identity collision for providerId "${row.providerId}" and accountId "${row.accountId}"`,
        );
      }
      identityOwners.set(key, row.id);
    }

    const repair = client.transaction(() => {
      client.prepare('DROP TABLE IF EXISTS "accounts_patch"').run();
      client
        .prepare(`CREATE TABLE "accounts_patch" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "accountId" TEXT NOT NULL,
        "providerId" TEXT NOT NULL,
        "accessToken" TEXT,
        "refreshToken" TEXT,
        "idToken" TEXT,
        "accessTokenExpiresAt" TEXT,
        "refreshTokenExpiresAt" TEXT,
        "scope" TEXT,
        "password" TEXT,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      )`)
        .run();
      const insert = client.prepare(`INSERT INTO "accounts_patch" (
        "id", "userId", "accountId", "providerId", "accessToken", "refreshToken", "idToken",
        "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of accountRows) {
        // Non-numeric TEXT ids get a fresh one; nothing references accounts.id.
        const id = Number.isInteger(Number(row.id)) ? Number(row.id) : null;
        insert.run(
          id,
          row.userId,
          row.accountId,
          row.providerId,
          row.accessToken,
          row.refreshToken,
          row.idToken,
          row.accessTokenExpiresAt,
          row.refreshTokenExpiresAt,
          row.scope,
          row.password,
          row.createdAt,
          row.updatedAt,
        );
      }
      client.prepare('DROP TABLE "accounts"').run();
      client.prepare('ALTER TABLE "accounts_patch" RENAME TO "accounts"').run();
      client
        .prepare(
          'CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "accounts" ("providerId", "accountId")',
        )
        .run();
      client.prepare('CREATE INDEX "accounts_user_idx" ON "accounts" ("userId")').run();
    });
    repair();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Failed to repair Better Auth accounts schema: ${detail}`, {
      cause: error,
    });
  }
}

/**
 * For deployments that ran an older 0020: 0021 skips `accounts`, `sessions` and `verifications`,
 * so their snake_case survivors break Better Auth.
 */
export function repairLegacySqliteSchema(client: Database) {
  // ── users ────────────────────────────────────────────────────────────────────
  addColumnIfMissing(
    client,
    "users",
    "email_verified",
    "emailVerified",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(client, "users", "username", "username", "TEXT");
  addColumnIfMissing(client, "users", "display_username", "displayUsername", "TEXT");

  // ── accounts ─────────────────────────────────────────────────────────────────
  renameColumnIfNeeded(client, "accounts", "user_id", "userId");
  renameColumnIfNeeded(client, "accounts", "account_id", "accountId");
  renameColumnIfNeeded(client, "accounts", "provider_id", "providerId");
  renameColumnIfNeeded(client, "accounts", "access_token", "accessToken");
  renameColumnIfNeeded(client, "accounts", "refresh_token", "refreshToken");
  renameColumnIfNeeded(client, "accounts", "id_token", "idToken");
  renameColumnIfNeeded(client, "accounts", "access_token_expires_at", "accessTokenExpiresAt");
  renameColumnIfNeeded(client, "accounts", "refresh_token_expires_at", "refreshTokenExpiresAt");
  renameColumnIfNeeded(client, "accounts", "created_at", "createdAt");
  renameColumnIfNeeded(client, "accounts", "updated_at", "updatedAt");
  fixAccountsSchema(client);

  // ── sessions ─────────────────────────────────────────────────────────────────
  fixSessionsSchema(client);
  renameColumnIfNeeded(client, "sessions", "user_id", "userId");
  renameColumnIfNeeded(client, "sessions", "expires_at", "expiresAt");
  renameColumnIfNeeded(client, "sessions", "ip_address", "ipAddress");
  renameColumnIfNeeded(client, "sessions", "user_agent", "userAgent");
  renameColumnIfNeeded(client, "sessions", "created_at", "createdAt");
  renameColumnIfNeeded(client, "sessions", "updated_at", "updatedAt");

  // ── verifications ─────────────────────────────────────────────────────────────
  renameColumnIfNeeded(client, "verifications", "expires_at", "expiresAt");
  renameColumnIfNeeded(client, "verifications", "created_at", "createdAt");
  renameColumnIfNeeded(client, "verifications", "updated_at", "updatedAt");
}
