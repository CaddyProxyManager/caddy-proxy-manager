/**
 * Finding and vetting a pre-3.0 SQLite database: each candidate is opened read-only and checked
 * against the schema before it is offered. Nothing here writes, so it can be pointed at anything.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { databaseDialect, resolveSqlitePath } from "../db/dialect";
import { MIGRATION_GROUPS, type MigrationGroupId } from "./selection";

/** Docker path, repo default, bare `bun start`. `LEGACY_SQLITE_PATH` overrides all of them. */
const SEARCH_DIRECTORIES = ["/app/data", "./data", "."];

/** Tables every version of the schema had. A file without them is not one of ours. */
const REQUIRED_TABLES = ["users", "settings", "proxy_hosts", "certificates"] as const;

export type LegacyCandidate = {
  path: string;
  sizeBytes: number;
  /** So an operator can tell two files apart. */
  counts: { users: number; proxyHosts: number; certificates: number; settings: number };
  groupCounts: Record<MigrationGroupId, number>;
  /** A hint at which file is the live one. */
  lastUpdatedAt: string | null;
};

/** A code, not a sentence: the setup screen renders it in the reader's language. */
export type LegacyRejectionReason = "missingFile" | "unreadable" | "notCpm" | "readFailed";
export type LegacyRejection = {
  path: string;
  reason: LegacyRejectionReason;
  /** What SQLite said, in English: a technical detail, shown as is. */
  detail?: string;
  /** For notCpm: the tables it lacks. */
  missingTables?: string[];
};

export type LegacyScan = {
  candidates: LegacyCandidate[];
  /** Kept so the UI can say why. */
  rejected: LegacyRejection[];
};

function tableNames(database: Database): Set<string> {
  const rows = database
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  return new Set(rows.map((row) => row.name));
}

function countRows(database: Database, table: string, present: Set<string>): number {
  if (!present.has(table)) return 0;
  // An identifier cannot be a parameter; this one comes from sqlite_master, not user input.
  const row = database.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get();
  return row?.n ?? 0;
}

function countGroups(database: Database, present: Set<string>): Record<MigrationGroupId, number> {
  const counts = {} as Record<MigrationGroupId, number>;
  for (const group of MIGRATION_GROUPS) {
    counts[group.id] = group.tables.reduce(
      (total, table) => total + countRows(database, table, present),
      0,
    );
  }
  return counts;
}

function newestUpdate(database: Database, present: Set<string>): string | null {
  let newest: string | null = null;
  for (const table of ["proxy_hosts", "settings", "users"]) {
    if (!present.has(table)) continue;
    try {
      const row = database
        .query<{ value: string | null }, []>(`SELECT MAX("updatedAt") AS value FROM "${table}"`)
        .get();
      if (row?.value && (!newest || row.value > newest)) newest = row.value;
    } catch {
      // An old schema without the column; it is a display hint only.
    }
  }
  return newest;
}

/** A rejection's reason is what tells an operator to pick another file. */
export function inspectLegacyDatabase(path: string): LegacyCandidate | LegacyRejection {
  if (!existsSync(path)) {
    return { path, reason: "missingFile" };
  }

  let database: Database;
  try {
    database = new Database(path, { readonly: true });
  } catch (error) {
    return { path, reason: "unreadable", detail: describe(error) };
  }

  try {
    const present = tableNames(database);
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      return { path, reason: "notCpm", missingTables: missing };
    }

    return {
      path,
      sizeBytes: statSync(path).size,
      counts: {
        users: countRows(database, "users", present),
        proxyHosts: countRows(database, "proxy_hosts", present),
        certificates: countRows(database, "certificates", present),
        settings: countRows(database, "settings", present),
      },
      groupCounts: countGroups(database, present),
      lastUpdatedAt: newestUpdate(database, present),
    };
  } catch (error) {
    return { path, reason: "readFailed", detail: describe(error) };
  } finally {
    database.close(true);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The live SQLite file, which sits in /app/data beside the legacy ones. */
function activeDatabaseFile(): string | null {
  if (databaseDialect(process.env) !== "sqlite") return null;
  try {
    return resolveSqlitePath(process.env.DATABASE_URL?.trim() ?? "");
  } catch {
    return null;
  }
}

function candidateFiles(): string[] {
  const pinned = process.env.LEGACY_SQLITE_PATH?.trim();
  if (pinned) {
    return [isAbsolute(pinned) ? pinned : resolve(process.cwd(), pinned)];
  }

  const found: string[] = [];
  for (const directory of SEARCH_DIRECTORIES) {
    const absolute = resolve(process.cwd(), directory);
    if (!existsSync(absolute)) continue;
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      continue; // Not worth failing the whole scan over.
    }
    for (const entry of entries) {
      // `-wal` and `-shm` are SQLite's sidecar files, not databases in their own right.
      if (!entry.endsWith(".db")) continue;
      const file = join(absolute, entry);
      if (!found.includes(file)) found.push(file);
    }
  }
  return found;
}

/** Several is common (a stale copy, a backup), so the operator picks: a wrong guess is silent. */
export function scanForLegacyDatabases(): LegacyScan {
  const candidates: LegacyCandidate[] = [];
  const rejected: LegacyRejection[] = [];

  const active = activeDatabaseFile();
  for (const path of candidateFiles()) {
    if (path === active) continue;
    const result = inspectLegacyDatabase(path);
    if ("reason" in result) {
      rejected.push(result);
    } else {
      candidates.push(result);
    }
  }

  // Busiest first: the file with the most proxy hosts is almost always the live one.
  candidates.sort((a, b) => b.counts.proxyHosts - a.counts.proxyHosts);
  return { candidates, rejected };
}
