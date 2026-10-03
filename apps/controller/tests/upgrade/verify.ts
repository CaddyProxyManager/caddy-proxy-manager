/**
 * The upgrade harness's second half, run by ./run.ts from this checkout's apps/controller.
 *
 *   UPGRADE_PHASE=upgrade: DATABASE_URL is what ./seed.ts left. Importing the db module runs this
 *     version's migrations, exactly as a deployment's first start does; then the startup passes.
 *   UPGRADE_PHASE=restore: DATABASE_URL is empty. The previous version's backup goes in.
 *
 * Writes JSON into UPGRADE_OUT/<phase> for run.ts to compare.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rawQuery, snapshotTables } from './snapshot';

const out = process.env.UPGRADE_OUT;
const phase = process.env.UPGRADE_PHASE;
if (!out || (phase !== 'upgrade' && phase !== 'restore')) {
  throw new Error('UPGRADE_OUT and UPGRADE_PHASE are not set; run tests/upgrade/run.ts');
}
const dir = resolve(out, phase);
mkdirSync(dir, { recursive: true });
const write = (name: string, value: unknown) =>
  writeFileSync(resolve(dir, name), JSON.stringify(value, null, 2));

// Awaits the migrations at import, as every route does.
const { client } = await import('../../src/lib/db');
const { dialect } = await import('../../src/lib/db/connection');
(await import('../../src/lib/demo/start')).installDemoCaddy();
const { buildCaddyDocument } = await import('../../src/lib/caddy');
const { createBackup, restoreBackup } = await import('../../src/lib/backup/service');
const { openBackup } = await import('../../src/lib/backup/format');
const PASSPHRASE = 'upgrade-passphrase';

async function exportedPayload(): Promise<unknown> {
  const sealed = await createBackup(PASSPHRASE, { auditLog: true, settingsHistory: true });
  return (await openBackup(sealed, PASSPHRASE)).tables;
}

/** Everything console.error receives while `run` runs: a boot that logs a failure did not boot. */
async function capturingErrors(run: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '));
    original(...args);
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return errors;
}

if (phase === 'restore') {
  const result = await restoreBackup(readFileSync(resolve(out, 'backup.cpmbak')), PASSPHRASE, {
    keepAgents: true,
  });
  write('restore-result.json', result);
  write('tables.json', await snapshotTables(client));
  write('document.json', await buildCaddyDocument());
  write('payload.json', await exportedPayload());
  process.exit(0);
}

write('tables-migrated.json', await snapshotTables(client));

const bootErrors = await capturingErrors(async () => {
  await (await import('../../src/instrumentation')).register();
});
write('boot-errors.json', bootErrors);
write('tables-booted.json', await snapshotTables(client));
write('document.json', await buildCaddyDocument());
const [edge] = await rawQuery(client, 'SELECT id FROM agents WHERE "agentId" = \'agent-edge-1\'');
write('document-agent.json', await buildCaddyDocument(Number(edge.id)));
write('payload.json', await exportedPayload());

// ── The rebuilt rules table ─────────────────────────────────────────────────

const checks: Record<string, unknown> = { dialect };
if (dialect === 'sqlite') {
  checks.foreignKeysPragma = await rawQuery(client, 'PRAGMA foreign_keys');
  checks.ruleForeignKeys = await rawQuery(
    client,
    "PRAGMA foreign_key_list('access_list_ip_rules')",
  );
  checks.foreignKeyViolations = await rawQuery(client, 'PRAGMA foreign_key_check');
  checks.integrity = await rawQuery(client, 'PRAGMA integrity_check');
  checks.ruleIndexes = await rawQuery(client, "PRAGMA index_list('access_list_ip_rules')");
} else {
  checks.ruleForeignKeys = await rawQuery(
    client,
    `SELECT kcu.column_name AS "from", ccu.table_name AS "table", rc.delete_rule AS on_delete
       FROM information_schema.referential_constraints rc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
        AND kcu.constraint_schema = rc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = rc.constraint_name AND ccu.constraint_schema = rc.constraint_schema
      WHERE kcu.table_name = 'access_list_ip_rules' AND kcu.table_schema = current_schema()`,
  );
  checks.ruleIndexes = await rawQuery(
    client,
    "SELECT indexname AS name FROM pg_indexes WHERE tablename = 'access_list_ip_rules' " +
      'AND schemaname = current_schema()',
  );
}

// Last: it deletes. The list a host uses goes through SQL, not the model, which would refuse.
const [list] = await rawQuery(client, "SELECT id FROM access_lists WHERE name = 'Office'");
const countRules = async () =>
  Number(
    (
      await rawQuery(
        client,
        `SELECT COUNT(*) AS n FROM access_list_ip_rules WHERE "accessListId" = ${list.id}`,
      )
    )[0].n,
  );
const rulesBefore = await countRules();
await rawQuery(client, `DELETE FROM access_lists WHERE id = ${list.id}`);
checks.cascade = { listId: list.id, rulesBefore, rulesAfter: await countRules() };
write('checks.json', checks);
process.exit(0);
