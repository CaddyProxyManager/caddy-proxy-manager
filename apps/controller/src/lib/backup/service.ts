/**
 * Backing up the whole configuration, and restoring it - onto this machine or a new one.
 *
 * Rows are copied table by table in foreign-key order with their ids, like the legacy importer
 * (whose table description and ordering this reuses). A backup made by an older version restores
 * onto a newer one: columns it lacks take their defaults, and columns it has that no longer exist
 * are dropped. One made by a newer version is refused, since it may rely on columns this one
 * would silently throw away.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { isNewer } from "../updates";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import pkg from "../../../package.json";
import db, { runInTransaction } from "../db";
import { activeSchema, schemaDialect } from "../db/schema";
import { domainError } from "../domain-error";
import { type Described, describeTables, inFkOrder, resyncSequence } from "../migration/import";
import { type BackupPayload, openBackup, readBackupHeader, sealBackup } from "./format";
import { exportRow, importRow } from "./secrets";

/** State that belongs to this running deployment, not its configuration. Never backed up. */
export const BACKUP_NEVER = [
  "sessions",
  "verifications",
  "oauth_states",
  "pending_oauth_links",
  "forward_auth_sessions",
  "forward_auth_exchanges",
  "forward_auth_redirect_intents",
  "settings_staged",
] as const;

/** History rather than configuration: large, and only included when asked for. */
export const BACKUP_OPTIONAL = { auditLog: "audit_events", settingsHistory: "settings_revisions" };

export type BackupOptions = { auditLog?: boolean; settingsHistory?: boolean };

const RESTORE_BATCH = 250;

function tablesToBackUp(options: BackupOptions): Described[] {
  const skip = new Set<string>(BACKUP_NEVER);
  if (!options.auditLog) skip.add(BACKUP_OPTIONAL.auditLog);
  if (!options.settingsHistory) skip.add(BACKUP_OPTIONAL.settingsHistory);
  return inFkOrder(describeTables()).filter((table) => !skip.has(table.name));
}

function drizzleTable(table: Described): PgTable {
  return activeSchema[table.key as keyof typeof activeSchema] as PgTable;
}

/** Drizzle's field name for each database column name, for this backend's table. */
function fieldsByColumn(table: Described): Map<string, string> {
  return new Map(
    Object.entries(getTableColumns(drizzleTable(table))).map(([field, column]) => [
      column.name,
      field,
    ]),
  );
}

export async function createBackup(
  passphrase: string,
  options: BackupOptions = {},
): Promise<Buffer> {
  const payload: BackupPayload = { tables: {} };
  for (const table of tablesToBackUp(options)) {
    // Keyed by database column name, which outlives any renaming of drizzle's fields.
    const columnOf = new Map([...fieldsByColumn(table)].map(([column, field]) => [field, column]));
    const rows = (await db.select().from(drizzleTable(table))) as Record<string, unknown>[];
    payload.tables[table.name] = await Promise.all(
      rows.map((row) =>
        exportRow(
          table.name,
          Object.fromEntries(Object.entries(row).map(([f, v]) => [columnOf.get(f) ?? f, v])),
        ),
      ),
    );
  }
  return await sealBackup(payload, passphrase, { appVersion: pkg.version });
}

/** What restoring would do, read from the header alone. */
export function describeBackup(file: Buffer) {
  const { header } = readBackupHeader(file);
  return {
    createdAt: header.createdAt,
    appVersion: header.appVersion,
    counts: header.counts,
    // Semver precedence, so a 3.0.0 backup counts as newer than a 3.0.0-beta.1 build.
    newerThanThis: isNewer(pkg.version, header.appVersion),
  };
}

/** Where the automatic backup taken before every restore is kept, on the controller's volume. */
export function preRestoreBackupDir(): string {
  // The same volume the agent bootstrap token uses; see lib/agent/bootstrap.ts.
  return join(process.env.L4_PORTS_DIR || "/app/data", "backups");
}

export type RestoreResult = { tables: number; rows: number; safetyBackup: string };

/**
 * Replace the configuration with the backup's.
 *
 * Everything is read, decrypted and converted before anything is written, and the write is one
 * transaction, so a bad file or a wrong passphrase leaves the database as it was. A backup of the
 * current state, under the same passphrase, is saved first.
 */
export async function restoreBackup(
  file: Buffer,
  passphrase: string,
  options: { keepAgents: boolean },
): Promise<RestoreResult> {
  if (describeBackup(file).newerThanThis) {
    throw domainError("backupFromNewerVersion", {}, { status: 400 });
  }
  const payload = await openBackup(file, passphrase);

  const all = inFkOrder(describeTables());
  const known = new Map(all.map((table) => [table.name, table]));
  const skip = new Set<string>(BACKUP_NEVER);
  if (!options.keepAgents) {
    // Pairings are with the machine the backup came from; on a new one the agents pair afresh.
    for (const table of all) {
      if (table.name === "agents" || table.references.some((r) => r.target === "agents")) {
        skip.add(table.name);
      }
    }
  }

  const prepared: { table: Described; rows: Record<string, unknown>[] }[] = [];
  for (const table of all) {
    if (skip.has(table.name)) continue;
    const rows = payload.tables[table.name];
    // A table the backup doesn't have (newer schema, or optional history left out) is left alone.
    if (!rows) continue;
    const fieldOf = fieldsByColumn(table);
    const booleans = new Set(table.columns.filter((c) => c.isBoolean).map((c) => c.name));
    prepared.push({
      table,
      rows: await Promise.all(
        rows.map(async (raw) => {
          const row = await importRow(table.name, raw);
          const kept: Record<string, unknown> = {};
          for (const [column, value] of Object.entries(row)) {
            const field = fieldOf.get(column);
            if (!field) continue;
            // An older SQLite build may have stored booleans as 0/1.
            kept[field] = booleans.has(column) && typeof value === "number" ? value === 1 : value;
          }
          return kept;
        }),
      ),
    });
  }
  for (const name of Object.keys(payload.tables)) {
    if (!known.has(name)) console.warn(`[backup] Skipping table ${name}, which this version lacks`);
  }

  const safetyBackup = join(preRestoreBackupDir(), `before-restore-${Date.now()}.cpmbak`);
  await mkdir(preRestoreBackupDir(), { recursive: true });
  await writeFile(
    safetyBackup,
    await createBackup(passphrase, { auditLog: true, settingsHistory: true }),
    {
      mode: 0o600,
    },
  );

  // Children first when clearing, parents first when filling. Sessions go too: they belong to the
  // users being replaced.
  const clearing = [...all].reverse().filter((table) => {
    if (table.name === "sessions" || table.name.startsWith("forward_auth_")) return true;
    return prepared.some((entry) => entry.table.name === table.name);
  });
  await runInTransaction((tx) => [
    ...clearing.map((table) => tx.delete(drizzleTable(table))),
    ...prepared.flatMap(({ table, rows }) => {
      const batches = [];
      for (let i = 0; i < rows.length; i += RESTORE_BATCH) {
        batches.push(tx.insert(drizzleTable(table)).values(rows.slice(i, i + RESTORE_BATCH)));
      }
      return batches;
    }),
  ]);

  if (schemaDialect === "postgres") {
    for (const { table } of prepared) {
      if (table.serialColumn) await resyncSequence(table.name, table.serialColumn);
    }
  }

  return {
    tables: prepared.length,
    rows: prepared.reduce((sum, entry) => sum + entry.rows.length, 0),
    safetyBackup,
  };
}
