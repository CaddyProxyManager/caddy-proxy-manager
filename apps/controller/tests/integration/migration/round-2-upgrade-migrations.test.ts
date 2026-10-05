import { describe, expect, it } from 'bun:test';
import { createTestDbBefore, testDialect } from '../../helpers/db';
import { rawQuery } from '../../upgrade/snapshot';

const NOW = '2026-09-01T12:00:00.000Z';

/** Rows as the version before round 2 wrote them, in the order a user put them. */
const RULES = [
  { id: 1, list: 1, action: 'deny', cidr: '203.0.113.66/32', note: 'Lobby kiosk', order: 0 },
  { id: 2, list: 1, action: 'allow', cidr: '203.0.113.0/24', note: 'HQ', order: 1 },
  { id: 3, list: 1, action: 'allow', cidr: '2001:db8:10::/48', note: 'HQ over IPv6', order: 2 },
  { id: 4, list: 1, action: 'allow', cidr: '198.51.100.7/32', note: null, order: 3 },
  // Ids out of step with the order, as a rewritten list leaves them.
  { id: 9, list: 2, action: 'allow', cidr: '192.0.2.10/32', note: 'Monitor', order: 0 },
  { id: 7, list: 2, action: 'deny', cidr: '2001:db8:bad::/48', note: 'Scanner v6', order: 1 },
  { id: 8, list: 2, action: 'deny', cidr: '192.0.2.0/24', note: 'Scanner', order: 2 },
];

type Seeded = Awaited<ReturnType<typeof createTestDbBefore>>;

async function seedPreviousVersion({ exec }: Seeded): Promise<void> {
  await exec(`INSERT INTO access_lists (id, name, "ipDefault", satisfy, "passAuth", "createdAt", "updatedAt")
    VALUES (1, 'Office', 'deny', 'any', FALSE, '${NOW}', '${NOW}'),
           (2, 'Blocklist', 'allow', 'any', FALSE, '${NOW}', '${NOW}')`);
  for (const rule of RULES) {
    await exec(`INSERT INTO access_list_ip_rules
      (id, "accessListId", action, cidr, note, "sortOrder", "createdAt", "updatedAt")
      VALUES (${rule.id}, ${rule.list}, '${rule.action}', '${rule.cidr}',
              ${rule.note === null ? 'NULL' : `'${rule.note}'`}, ${rule.order}, '${NOW}', '${NOW}')`);
  }
  await exec(`INSERT INTO access_list_entries ("accessListId", username, "passwordHash", "createdAt", "updatedAt")
    VALUES (1, 'alice', '$2b$10$abcdefghijklmnopqrstuv', '${NOW}', '${NOW}')`);
  await exec(`INSERT INTO proxy_hosts (id, name, domains, upstreams, "accessListId", "createdAt", "updatedAt")
    VALUES (1, 'App', '["app.example.com"]', '["10.0.0.1:80"]', 1, '${NOW}', '${NOW}')`);
  await exec(`INSERT INTO certificates (id, name, type, "domainNames", "certificatePem", "privateKeyPem", "createdAt", "updatedAt")
    VALUES (1, 'Imported', 'imported', '["app.example.com"]', 'PEM', 'enc:v1:key', '${NOW}', '${NOW}')`);
  await exec(`INSERT INTO l4_proxy_hosts (id, name, protocol, "listenAddress", upstreams, "createdAt", "updatedAt")
    VALUES (1, 'SSH', 'tcp', ':2222', '["10.0.0.2:22"]', '${NOW}', '${NOW}')`);
  await exec(`INSERT INTO oauth_providers (id, name, "clientId", "clientSecret", "createdAt", "updatedAt")
    VALUES ('p1', 'Keycloak', 'enc:v1:id', 'enc:v1:secret', '${NOW}', '${NOW}')`);
}

/**
 * The way the app runs them: drizzle's migrator wraps every pending migration in one transaction,
 * where SQLite ignores the rebuild's `PRAGMA foreign_keys=OFF`.
 */
async function migrateLikeTheApp({ exec, migrateRest }: Seeded): Promise<void> {
  if (testDialect !== 'sqlite') return migrateRest();
  await exec('BEGIN');
  await migrateRest();
  await exec('COMMIT');
}

function raw(db: Seeded['db']) {
  return (db as unknown as { $client: Parameters<typeof rawQuery>[0] }).$client;
}

describe('upgrading a round-1 database', () => {
  it('keeps every IP rule, its order and its note, and leaves the new hostname empty', async () => {
    const seeded = await createTestDbBefore('l4_access_list');
    await seedPreviousVersion(seeded);
    await migrateLikeTheApp(seeded);

    const rows = await rawQuery(
      raw(seeded.db),
      `SELECT id, "accessListId", action, cidr, hostname, note FROM access_list_ip_rules
        ORDER BY "accessListId", "sortOrder"`,
    );
    expect(rows).toEqual(
      RULES.map((rule) => ({
        id: rule.id,
        accessListId: rule.list,
        action: rule.action,
        cidr: rule.cidr,
        hostname: null,
        note: rule.note,
      })),
    );
  });

  it('gives existing rows the new columns their defaults', async () => {
    const seeded = await createTestDbBefore('l4_access_list');
    await seedPreviousVersion(seeded);
    await migrateLikeTheApp(seeded);
    const client = raw(seeded.db);

    expect(
      await rawQuery(
        client,
        `SELECT source, "sourceAgentId", "sourceCertPath", "sourceKeyPath", "sourceReadAt",
                "sourceError", "privateKeyPem" FROM certificates`,
      ),
    ).toEqual([
      {
        source: 'upload',
        sourceAgentId: null,
        sourceCertPath: null,
        sourceKeyPath: null,
        sourceReadAt: null,
        sourceError: null,
        privateKeyPem: 'enc:v1:key',
      },
    ]);
    expect(await rawQuery(client, 'SELECT "accessListId" FROM l4_proxy_hosts')).toEqual([
      { accessListId: null },
    ]);
    expect(await rawQuery(client, 'SELECT "ldapConfig" FROM oauth_providers')).toEqual([
      { ldapConfig: null },
    ]);
    expect(await rawQuery(client, 'SELECT "accessListId" FROM proxy_hosts')).toEqual([
      { accessListId: 1 },
    ]);
    const [entries] = await rawQuery(client, 'SELECT COUNT(*) AS n FROM access_list_entries');
    expect(Number(entries.n)).toBe(1);
  });

  it('still deletes a list’s rules with the list after the rebuild', async () => {
    const seeded = await createTestDbBefore('l4_access_list');
    await seedPreviousVersion(seeded);
    await migrateLikeTheApp(seeded);
    const client = raw(seeded.db);

    if (testDialect === 'sqlite') {
      const keys = await rawQuery(client, "PRAGMA foreign_key_list('access_list_ip_rules')");
      expect(keys).toEqual([
        expect.objectContaining({
          table: 'access_lists',
          from: 'accessListId',
          on_delete: 'CASCADE',
        }),
      ]);
      expect(await rawQuery(client, 'PRAGMA foreign_key_check')).toEqual([]);
      expect(await rawQuery(client, 'PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    }

    await seeded.exec('DELETE FROM access_lists WHERE id = 1');
    const left = await rawQuery(
      client,
      'SELECT DISTINCT "accessListId" FROM access_list_ip_rules ORDER BY "accessListId"',
    );
    expect(left).toEqual([{ accessListId: 2 }]);
    // The host's own reference is ON DELETE SET NULL, and survived the rebuild beside it.
    expect(await rawQuery(client, 'SELECT "accessListId" FROM proxy_hosts')).toEqual([
      { accessListId: null },
    ]);
  });
});
