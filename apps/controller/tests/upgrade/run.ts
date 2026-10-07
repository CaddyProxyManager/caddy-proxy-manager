/**
 * Upgrades a database an older checkout wrote, with that checkout's own code, to this one:
 *
 *   git worktree add --detach ../cpm-main main && (cd ../cpm-main && bun install)
 *   bun run test:upgrade --from ../cpm-main [--dialect sqlite]      (from apps/controller)
 *
 * Proves every row survives the migrations unchanged, new columns take their defaults, the
 * startup passes run clean, the Caddy document is the one the old version built, and the old
 * version's backup restores here. Exits non-zero on any unexplained difference.
 */
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { jsonDiff, type Row, type Tables } from './snapshot';

const argv = yargs(hideBin(process.argv))
  .scriptName('upgrade')
  .option('from', { type: 'string', demandOption: true, describe: 'older checkout (repo root)' })
  .option('dialect', { choices: ['postgres', 'sqlite', 'both'] as const, default: 'both' })
  .option('out', { type: 'string', describe: 'where the JSON goes; a temp dir by default' })
  .strict()
  .help()
  .parseSync();

const HERE = import.meta.dir;
const CONTROLLER = resolve(HERE, '../..');
const PREVIOUS = resolve(argv.from, 'apps/controller');
if (!existsSync(resolve(PREVIOUS, 'src/lib/db/schema.ts'))) {
  throw new Error(`${argv.from} is not a checkout of this repository`);
}

/** New columns and what the migrations must leave in them on an existing row. */
const NEW_COLUMN_DEFAULTS: Record<string, Record<string, unknown>> = {
  certificates: {
    source: 'upload',
    sourceAgentId: null,
    sourceCertPath: null,
    sourceKeyPath: null,
    sourceReadAt: null,
    sourceError: null,
  },
  l4_proxy_hosts: { accessListId: null },
  access_list_ip_rules: { hostname: null },
  oauth_providers: { ldapConfig: null },
  groups: { role: null, scimGroupId: null },
};

/** Commas only, trimmed, a repeat once: how a role column's names were read. */
const splitNames = (value: unknown) =>
  typeof value === 'string'
    ? [
        ...new Set(
          value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      ]
    : [];

/**
 * Columns a migration moved into another table, each checked where it went instead of where it
 * was: a table with rows only because of the move is expected to have them.
 */
const MOVED_COLUMNS: Array<{
  table: string;
  columns: string[];
  into: string;
  why: string;
  check: (before: Tables, after: Tables) => string[];
}> = [
  {
    table: 'oauth_providers',
    columns: ['adminGroup', 'operatorGroup', 'userGroup', 'viewerGroup'],
    into: 'role_mappings',
    why: 'custom roles: each provider role group became role_mappings rows',
    check: (before, after) => {
      const failures: string[] = [];
      const rows = after.role_mappings ?? [];
      for (const provider of before.oauth_providers ?? []) {
        for (const [column, role] of [
          ['adminGroup', 'admin'],
          ['operatorGroup', 'operator'],
          ['userGroup', 'user'],
          ['viewerGroup', 'viewer'],
        ]) {
          const moved = rows
            .filter((row) => row.providerId === provider.id && row.role === role)
            .map((row) => row.externalName);
          const wanted = splitNames(provider[column]);
          if (JSON.stringify(moved) !== JSON.stringify(wanted)) {
            failures.push(
              `${provider.id} ${role}: ${JSON.stringify(wanted)} became ${JSON.stringify(moved)}`,
            );
          }
        }
      }
      const known = new Set((before.oauth_providers ?? []).map((provider) => provider.id));
      const stray = rows.filter((row) => !known.has(row.providerId));
      if (stray.length > 0) failures.push(`${stray.length} mapping(s) for no provider`);
      return failures;
    },
  },
];

/**
 * Deliberate differences in this version's document, each undone on a copy before comparing: a
 * handler chain that differs in any other way fails the run.
 */
const KNOWN_DOCUMENT_CHANGES: Array<{ why: string; undo: (handle: Row[]) => Row[] }> = [
  {
    why: 'compression is on by default for every host (plan E1: compression_enabled)',
    undo: (handle) =>
      handle.filter(
        (h) =>
          !(
            h.handler === 'encode' && JSON.stringify(h.prefer) === JSON.stringify(['zstd', 'gzip'])
          ),
      ),
  },
  {
    why: 'geo blocking runs before the WAF, so a blocked country never reaches Coraza (397776f0)',
    undo: (handle) => {
      const at = handle.findIndex(
        (h, i) => h.handler === 'blocker' && handle[i + 1]?.handler === 'waf',
      );
      if (at < 0) return handle;
      const swapped = [...handle];
      [swapped[at], swapped[at + 1]] = [swapped[at + 1], swapped[at]];
      return swapped;
    },
  },
];

/** Applies one known change's undo to every handler chain in the document. */
function undoing(document: unknown, undo: (handle: Row[]) => Row[]): unknown {
  if (Array.isArray(document)) return document.map((item) => undoing(item, undo));
  if (document === null || typeof document !== 'object') return document;
  const copy: Row = {};
  for (const [key, value] of Object.entries(document)) {
    copy[key] = undoing(value, undo);
  }
  if (Array.isArray(copy.handle)) copy.handle = undo(copy.handle as Row[]);
  return copy;
}

/**
 * Rows the startup passes rewrite on their own schedule, so neither the boot comparison nor the
 * restore comparison can expect them to hold still.
 */
const VOLATILE_ROWS: Array<{ table: string; matches: (row: Row) => boolean; why: string }> = [
  {
    table: 'settings',
    matches: (row) => row.key === 'crs_plugin_registry_state',
    why: 'the CRS registry updater refreshes it from GitHub once started',
  },
  {
    table: 'notification_channels',
    matches: (row) => row.builtin !== null,
    why: 'the built-in email and push channels are created on first use, with that time',
  },
  {
    table: 'alert_rules',
    matches: (row) => row.builtin !== null,
    why: "each notification category's built-in rule is created on first use, with that time",
  },
];

const isVolatile = (table: string, row: Row) =>
  VOLATILE_ROWS.some((entry) => entry.table === table && entry.matches(row));

type Failure = string;

function compareTables(before: Tables, after: Tables, failures: Failure[]): string[] {
  const notes: string[] = [];
  for (const [table, rows] of Object.entries(before)) {
    const upgraded = after[table];
    if (!upgraded) {
      failures.push(`table ${table} is gone`);
      continue;
    }
    if (upgraded.length !== rows.length) {
      failures.push(`${table}: ${rows.length} rows before, ${upgraded.length} after`);
      continue;
    }
    const added = new Set<string>();
    const moved = new Set(
      MOVED_COLUMNS.filter((move) => move.table === table).flatMap((move) => move.columns),
    );
    rows.forEach((row, index) => {
      const next = upgraded[index];
      for (const [column, value] of Object.entries(row)) {
        if (moved.has(column) && !(column in next)) continue;
        if (JSON.stringify(next[column]) !== JSON.stringify(value)) {
          failures.push(
            `${table}[${index}].${column}: ${JSON.stringify(value)} -> ${JSON.stringify(next[column])}`,
          );
        }
      }
      for (const column of Object.keys(next)) if (!(column in row)) added.add(column);
    });
    for (const column of added) {
      const expected = NEW_COLUMN_DEFAULTS[table];
      if (!expected || !(column in expected)) {
        failures.push(`${table}.${column} is new and has no documented default here`);
        continue;
      }
      const wrong = upgraded.filter(
        (row) => JSON.stringify(row[column]) !== JSON.stringify(expected[column]),
      );
      if (wrong.length > 0) {
        failures.push(`${table}.${column}: ${wrong.length} row(s) not ${expected[column]}`);
      } else {
        notes.push(
          `${table}.${column} = ${JSON.stringify(expected[column])} on ${rows.length} row(s)`,
        );
      }
    }
  }
  for (const move of MOVED_COLUMNS) {
    if (!before[move.table]) continue;
    const problems = move.check(before, after);
    for (const problem of problems) failures.push(`${move.into}: ${problem}`);
    if (problems.length === 0) {
      notes.push(`${move.table}.{${move.columns.join(',')}} moved into ${move.into}: ${move.why}`);
    }
  }
  const movedInto = new Set(MOVED_COLUMNS.map((move) => move.into));
  for (const [table, rows] of Object.entries(after)) {
    if (before[table]) continue;
    if (rows.length > 0 && !movedInto.has(table))
      failures.push(`new table ${table} has ${rows.length} rows after migrating`);
    else notes.push(`new table ${table} (${rows.length ? `${rows.length} moved rows` : 'empty'})`);
  }
  return notes;
}

function rowKey(row: Row): string {
  return JSON.stringify(row.id ?? row.key ?? row);
}

function bootWrites(migrated: Tables, booted: Tables): Array<{ table: string; change: string }> {
  const writes: Array<{ table: string; change: string }> = [];
  for (const [table, rows] of Object.entries(booted)) {
    const earlier = new Map((migrated[table] ?? []).map((row) => [rowKey(row), row]));
    for (const row of rows) {
      if (isVolatile(table, row)) {
        earlier.delete(rowKey(row));
        continue;
      }
      const was = earlier.get(rowKey(row));
      if (!was) writes.push({ table, change: `added ${JSON.stringify(row).slice(0, 160)}` });
      else if (JSON.stringify(was) !== JSON.stringify(row)) {
        writes.push({ table, change: jsonDiff(was, row, rowKey(row)).join('; ') });
      }
      earlier.delete(rowKey(row));
    }
    for (const gone of earlier.keys()) writes.push({ table, change: `removed ${gone}` });
  }
  return writes;
}

async function childEnv(databaseUrl: string, out: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'upgrade-harness-session-secret-0123456789',
    ADMIN_USERNAME: 'upgradeadmin',
    ADMIN_PASSWORD: 'Upgrade-Admin-Password-1',
    NEXT_RUNTIME: 'nodejs',
    // Where the bootstrap token and a restore's safety backup go, instead of /app/data.
    L4_PORTS_DIR: out,
    UPGRADE_OUT: out,
    CPM_EPHEMERAL_DB: '',
  };
}

async function spawnPhase(cwd: string, script: string, env: Record<string, string>) {
  const child = Bun.spawn(['bun', script], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${script} in ${cwd} exited ${code}\n${stdout.slice(-4000)}\n${stderr.slice(-4000)}`,
    );
  }
}

async function databases(dialect: 'postgres' | 'sqlite', out: string) {
  if (dialect === 'sqlite') {
    return {
      upgrade: `file:${join(out, 'upgrade.db')}`,
      restore: `file:${join(out, 'restore.db')}`,
      drop: async () => {},
    };
  }
  const adminUrl = process.env.TEST_POSTGRES_URL;
  if (!adminUrl) throw new Error('Run under scripts/with-test-db.ts, or set TEST_POSTGRES_URL');
  const admin = new SQL({ url: adminUrl, max: 1 });
  const stem = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const urls: Record<string, string> = {};
  for (const which of ['upgrade', 'restore']) {
    await admin.unsafe(`CREATE DATABASE "${stem}_${which}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${stem}_${which}`;
    urls[which] = url.toString();
  }
  return {
    upgrade: urls.upgrade,
    restore: urls.restore,
    drop: async () => {
      for (const which of ['upgrade', 'restore']) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${stem}_${which}" WITH (FORCE)`);
      }
      await admin.close();
    },
  };
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

async function runDialect(dialect: 'postgres' | 'sqlite'): Promise<Failure[]> {
  const out = argv.out
    ? resolve(argv.out, dialect)
    : mkdtempSync(join(tmpdir(), `cpm-upgrade-${dialect}-`));
  const db = await databases(dialect, out);
  const failures: Failure[] = [];
  try {
    await spawnPhase(PREVIOUS, resolve(HERE, 'seed.ts'), await childEnv(db.upgrade, out));
    const upgradeEnv = { ...(await childEnv(db.upgrade, out)), UPGRADE_PHASE: 'upgrade' };
    await spawnPhase(CONTROLLER, resolve(HERE, 'verify.ts'), upgradeEnv);
    const restoreEnv = { ...(await childEnv(db.restore, out)), UPGRADE_PHASE: 'restore' };
    await spawnPhase(CONTROLLER, resolve(HERE, 'verify.ts'), restoreEnv);

    const before = read<Tables>(join(out, 'tables.json'));
    const migrated = read<Tables>(join(out, 'upgrade/tables-migrated.json'));
    console.log(`\n[${dialect}] ${out}`);
    for (const note of compareTables(before, migrated, failures)) console.log(`  ${note}`);
    const counted = Object.entries(before).filter(([, rows]) => rows.length > 0);
    console.log(
      `  ${counted.reduce((sum, [, rows]) => sum + rows.length, 0)} rows in ${counted.length} tables compared`,
    );

    const bootErrors = read<string[]>(join(out, 'upgrade/boot-errors.json'));
    for (const error of bootErrors)
      failures.push(`startup logged an error: ${error.slice(0, 300)}`);
    const writes = bootWrites(migrated, read<Tables>(join(out, 'upgrade/tables-booted.json')));
    for (const write of writes) failures.push(`startup wrote ${write.table}: ${write.change}`);
    if (writes.length === 0) console.log('  startup passes ran clean and wrote nothing');

    for (const [file, label] of [
      ['document.json', 'fleet'],
      ['document-agent.json', 'pinned agent'],
    ]) {
      let normalized = read<unknown>(join(out, 'upgrade', file));
      for (const change of KNOWN_DOCUMENT_CHANGES) {
        const undone = undoing(normalized, change.undo);
        if (jsonDiff(normalized, undone).length > 0) {
          console.log(`  ${label} document differs as expected: ${change.why}`);
        }
        normalized = undone;
      }
      const documentDiff = jsonDiff(read<unknown>(join(out, file)), normalized);
      for (const line of documentDiff) failures.push(`${label} document: ${line.slice(0, 400)}`);
      if (documentDiff.length === 0) {
        console.log(`  ${label} Caddy document otherwise identical to the previous version`);
      }
    }

    const checks = read<Record<string, unknown>>(join(out, 'upgrade/checks.json'));
    const fks = checks.ruleForeignKeys as Row[];
    const toLists = fks.find((fk) => fk.table === 'access_lists' && fk.from === 'accessListId');
    if (String(toLists?.on_delete).toUpperCase() !== 'CASCADE') {
      failures.push(`access_list_ip_rules lost its cascade: ${JSON.stringify(fks)}`);
    }
    const cascade = checks.cascade as { rulesBefore: number; rulesAfter: number };
    if (cascade.rulesBefore === 0 || cascade.rulesAfter !== 0) {
      failures.push(`deleting a list did not cascade its rules: ${JSON.stringify(cascade)}`);
    }
    if (dialect === 'sqlite') {
      if ((checks.foreignKeyViolations as Row[]).length > 0) {
        failures.push(`foreign_key_check: ${JSON.stringify(checks.foreignKeyViolations)}`);
      }
      if ((checks.integrity as Row[])[0]?.integrity_check !== 'ok') {
        failures.push(`integrity_check: ${JSON.stringify(checks.integrity)}`);
      }
      if ((checks.foreignKeysPragma as Row[])[0]?.foreign_keys !== 1) {
        failures.push('foreign_keys is off after migrating');
      }
    }
    const indexes = (checks.ruleIndexes as Row[]).map((row) => row.name);
    if (!indexes.includes('access_list_ip_rules_list_idx')) {
      failures.push(`access_list_ip_rules lost its index: ${JSON.stringify(indexes)}`);
    }
    console.log(`  cascade: ${JSON.stringify(cascade)}; indexes: ${indexes.join(', ')}`);

    // The previous version's backup, restored here, must equal the upgraded database.
    const upgradedPayload = read<Tables>(join(out, 'upgrade/payload.json'));
    const restoredPayload = read<Tables>(join(out, 'restore/payload.json'));
    for (const table of new Set([
      ...Object.keys(upgradedPayload),
      ...Object.keys(restoredPayload),
    ])) {
      // A backup reads without ORDER BY, and PostgreSQL returns updated rows wherever they landed.
      const sorted = (rows: Row[] = []) =>
        rows
          .filter((row) => !isVolatile(table, row))
          .sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
      const diff = jsonDiff(sorted(upgradedPayload[table]), sorted(restoredPayload[table]));
      for (const line of diff) failures.push(`restored ${table}: ${line.slice(0, 300)}`);
    }
    const restoredDiff = jsonDiff(
      read<unknown>(join(out, 'upgrade/document.json')),
      read<unknown>(join(out, 'restore/document.json')),
    );
    for (const line of restoredDiff) failures.push(`restored document: ${line.slice(0, 300)}`);
    const result = read<{ tables: number; rows: number }>(join(out, 'restore/restore-result.json'));
    console.log(
      `  previous version's backup restored: ${result.rows} rows in ${result.tables} tables`,
    );
  } finally {
    await db.drop();
  }
  return failures;
}

const dialects: Array<'postgres' | 'sqlite'> =
  argv.dialect === 'both' ? ['postgres', 'sqlite'] : [argv.dialect as 'postgres' | 'sqlite'];
let failed = false;
for (const dialect of dialects) {
  const failures = await runDialect(dialect);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  failed ||= failures.length > 0;
}
process.exit(failed ? 1 : 0);
