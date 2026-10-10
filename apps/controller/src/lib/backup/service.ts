/**
 * Rows keep their ids, in the legacy importer's FK order. An older backup restores (missing columns
 * default, gone ones drop); a newer one is refused, since this build would drop columns it needs.
 */
import { legacyRoleMappings } from "../roles/mappings";
import { mkdir, writeFile } from "node:fs/promises";
import { isNewer } from "../runtime/updates";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import pkg from "../../../package.json";
import db, { runInTransaction } from "../db";
import { activeSchema, schemaDialect } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { reanchorAuditChain } from "../audit/chain";
import { type Described, describeTables, inFkOrder, resyncSequence } from "../migration/import";
import { type BackupPayload, openBackup, readBackupHeader, sealBackup } from "./format";
import { exportRow, importRow } from "./secrets";

/** State that belongs to this running deployment, not its configuration. Never backed up. */
export const BACKUP_NEVER = [
  "sessions",
  "verifications",
  "forward_auth_sessions",
  "forward_auth_exchanges",
  "forward_auth_redirect_intents",
  "settings_staged",
  // Re-resolved within a minute of starting, and a name's answer may differ on the new host.
  "access_list_dns_cache",
  // Re-derived from the restored audit events (reanchorAuditChain), whichever side they came from.
  "audit_chain",
  // The running cluster's own state: replicas, streams, messages in flight, counters and nonces
  // that expire within the day. Restoring them would name replicas and streams that are gone.
  "controller_replicas",
  "cluster_generations",
  "agent_connections",
  "agent_outbox",
  "agent_command_results",
  "rate_limit_counters",
  "spent_nonces",
  "agent_pairing_secrets",
  "upstream_error_counts",
  // Tens of megabytes the leader downloads again; the files on the data volume are what serve.
  "geoip_databases",
  // What this deployment's scheduler did; the destinations and schedules themselves are kept.
  "backup_runs",
  // What this deployment raised and sent, and when its digests went; channels and rules are kept.
  "alert_keys",
  "alert_events",
  "alert_deliveries",
  "alert_digest_runs",
  // Security records waiting for a sink: this deployment's traffic, sent or pruned within the day.
  "audit_security_records",
  "audit_security_head",
] as const;

/** History rather than configuration: large, and only included when asked for. */
export const BACKUP_OPTIONAL = {
  auditLog: "audit_events",
  settingsHistory: "settings_revisions",
  // Asked for together with settings history: one choice for "the history of my configuration".
  hostHistory: "host_revisions",
};

export type BackupOptions = { auditLog?: boolean; settingsHistory?: boolean };

const RESTORE_BATCH = 250;

function tablesToBackUp(options: BackupOptions): Described[] {
  const skip = new Set<string>(BACKUP_NEVER);
  if (!options.auditLog) skip.add(BACKUP_OPTIONAL.auditLog);
  if (!options.settingsHistory) {
    skip.add(BACKUP_OPTIONAL.settingsHistory);
    skip.add(BACKUP_OPTIONAL.hostHistory);
  }
  return inFkOrder(describeTables()).filter((table) => !skip.has(table.name));
}

function drizzleTable(table: Described): PgTable {
  return activeSchema[table.key as keyof typeof activeSchema] as PgTable;
}

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

export function preRestoreBackupDir(): string {
  // The same volume the agent bootstrap token uses; see lib/agent/bootstrap.ts.
  return join(process.env.L4_PORTS_DIR || "/app/data", "backups");
}

export type RestoreResult = { tables: number; rows: number; safetyBackup: string };

/** Everything is converted before one write transaction, so a bad file changes nothing. */
export async function restoreBackup(
  file: Buffer,
  passphrase: string,
  options: { keepAgents: boolean },
): Promise<RestoreResult> {
  if (describeBackup(file).newerThanThis) {
    throw domainError("backupFromNewerVersion", {}, { status: 400 });
  }
  const payload = await openBackup(file, passphrase);
  // Again, now the header is authenticated: the check above only saves asking for a passphrase.
  if (isNewer(pkg.version, payload.header.appVersion)) {
    throw domainError("backupFromNewerVersion", {}, { status: 400 });
  }

  const all = inFkOrder(describeTables());
  const known = new Map(all.map((table) => [table.name, table]));
  const skip = new Set<string>(BACKUP_NEVER);
  /** Columns naming an agent that is not restored: the row stays, pointing at no agent. */
  const orphaned = new Map<string, string[]>();
  if (!options.keepAgents) {
    // Pairings are with the machine the backup came from; on a new one the agents pair afresh.
    for (const table of all) {
      const toAgents = table.references.filter((r) => r.target === "agents");
      if (table.name === "agents" || toAgents.some((r) => r.required)) {
        skip.add(table.name);
      } else if (toAgents.length > 0) {
        orphaned.set(
          table.name,
          toAgents.flatMap((r) => r.columns),
        );
      }
    }
  }

  const prepared: { table: Described; rows: Record<string, unknown>[] }[] = [];
  for (const table of all) {
    if (skip.has(table.name)) continue;
    const rows =
      payload.tables[table.name] ??
      (table.name === "role_mappings"
        ? legacyRoleMappings(payload.tables.oauth_providers)
        : undefined);
    // A table the backup doesn't have (newer schema, or optional history left out) is left alone.
    if (!rows) continue;
    const fieldOf = fieldsByColumn(table);
    const booleans = new Set(table.columns.filter((c) => c.isBoolean).map((c) => c.name));
    prepared.push({
      table,
      rows: await Promise.all(
        rows.map(async (raw) => {
          const row = await importRow(table.name, raw);
          for (const column of orphaned.get(table.name) ?? []) row[column] = null;
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
    // Restored schedules reuse ids, and a run left behind would be credited to another schedule.
    if (table.name === "backup_runs") {
      return prepared.some((entry) => entry.table.name === "backup_schedules");
    }
    // Restored hosts reuse ids, so revisions left behind would read as another host's past.
    if (table.name === BACKUP_OPTIONAL.hostHistory) {
      return prepared.some((entry) => ["proxy_hosts", "l4_proxy_hosts"].includes(entry.table.name));
    }
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
  if (prepared.some(({ table }) => table.name === BACKUP_OPTIONAL.auditLog)) {
    // Re-hashed under this key: the backup may be another installation's, or from before the chain.
    await reanchorAuditChain();
  }

  return {
    tables: prepared.length,
    rows: prepared.reduce((sum, entry) => sum + entry.rows.length, 0),
    safetyBackup,
  };
}
