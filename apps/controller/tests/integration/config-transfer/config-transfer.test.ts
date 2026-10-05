/**
 * Portable config between two instances: rows travel by natural key, ids are remapped (inside JSON
 * columns too), secrets stay sealed in the file and re-encrypt on arrival, users match by email and
 * a domain another host already serves is reported, never overwritten.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';

let db: TestDb;
vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));

import * as schema from '../../../src/lib/db/schema';
import { schema as gqlSchema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { decryptSecret, encryptSecret } from '../../../src/lib/secrets';
import {
  applyConfigImport,
  describeConfigFile,
  exportConfig,
  previewConfigImport,
  type ConfigSection,
} from '../../../src/lib/config-transfer';

const PASSPHRASE = 'correct horse battery staple';
const NOW = '2026-10-01T00:00:00.000Z';
const BCRYPT = `$2b$10$${'a'.repeat(53)}`;
const at = { createdAt: NOW, updatedAt: NOW };

async function user(id: number, email: string) {
  await db.insert(schema.users).values({
    id,
    email,
    role: 'admin',
    provider: 'credentials',
    subject: email,
    status: 'active',
    ...at,
  });
}

/** The source instance: one of everything, ids deliberately unlike the target's. */
async function seedSource() {
  await user(1, 'admin@example.com');
  await user(2, 'bea@example.com');
  await db.insert(schema.agents).values({
    id: 3,
    name: 'edge',
    agentId: 'a'.repeat(32),
    secret: encryptSecret('s'),
    ...at,
  });
  await db.insert(schema.wafPresets).values([
    { id: 4, name: 'filler', directives: 'SecRuleEngine On', ...at },
    { id: 5, name: 'wordpress', directives: 'SecRuleRemoveById 1', ...at },
  ]);
  await db.insert(schema.certificates).values({
    id: 6,
    name: 'wildcard',
    type: 'imported',
    domainNames: '["*.example.com"]',
    certificatePem: 'CERT',
    privateKeyPem: encryptSecret('PRIVATE KEY'),
    ...at,
  });
  await db.insert(schema.accessLists).values({ id: 7, name: 'office', ...at });
  await db.insert(schema.accessListEntries).values({
    accessListId: 7,
    username: 'alice',
    passwordHash: BCRYPT,
    ...at,
  });
  await db.insert(schema.accessListIpRules).values({
    accessListId: 7,
    action: 'allow',
    country: 'DE',
    sortOrder: 0,
    ...at,
  });
  await db.insert(schema.proxyHosts).values([
    {
      id: 8,
      name: 'app',
      domains: '["app.example.com"]',
      upstreams: '["app:80"]',
      certificateId: 6,
      accessListId: 7,
      ownerUserId: 2,
      meta: JSON.stringify({
        waf: { enabled: true, preset_ids: [5] },
        location_rules: [{ path: '/admin', upstreams: ['a:1'], access_list_id: 7 }],
        forward_auth: { secret: 'hush' },
      }),
      ...at,
    },
    { id: 9, name: 'clash', domains: '["taken.example.com"]', upstreams: '["b:80"]', ...at },
  ]);
  await db.insert(schema.proxyHostAgents).values({ proxyHostId: 8, agentId: 3, createdAt: NOW });
  await db.insert(schema.groups).values({ id: 10, name: 'ops', ...at });
  await db.insert(schema.groupMembers).values([
    { groupId: 10, userId: 2, createdAt: NOW },
    { groupId: 10, userId: 1, createdAt: NOW },
  ]);
  await db.insert(schema.groupGrants).values({ groupId: 10, proxyHostId: 8, createdAt: NOW });
  await db
    .insert(schema.wafExclusions)
    .values({ ruleId: 942100, proxyHostId: 8, reason: 'fp', ...at });
  await db.insert(schema.blockedSources).values({ kind: 'country', value: 'KP', createdAt: NOW });
  await db.insert(schema.settings).values([
    {
      key: 'waf',
      value: JSON.stringify({ enabled: true, mode: 'On', preset_ids: [5] }),
      updatedAt: NOW,
    },
    {
      key: 'dashboard',
      value: JSON.stringify({ enabled: true, domain: 'cpm.source' }),
      updatedAt: NOW,
    },
    {
      key: 'dns_provider',
      value: JSON.stringify({
        providers: { cloudflare: { api_token: encryptSecret('cf-token') } },
      }),
      updatedAt: NOW,
    },
  ]);
}

/** The target: the same people under other ids, one agent, and a host on a name the file wants. */
async function seedTarget() {
  await user(1, 'admin@example.com');
  await user(5, 'other@example.com');
  await user(7, 'BEA@example.com');
  await db.insert(schema.agents).values({
    id: 11,
    name: 'edge',
    agentId: 'b'.repeat(32),
    secret: encryptSecret('t'),
    ...at,
  });
  await db.insert(schema.proxyHosts).values({
    id: 1,
    name: 'already here',
    domains: '["taken.example.com"]',
    upstreams: '["x:80"]',
    ...at,
  });
}

async function exported(sections?: ConfigSection[]) {
  db = await createTestDb();
  await seedSource();
  return await exportConfig(PASSPHRASE, { sections });
}

beforeEach(() => {});

describe('config export', () => {
  it('writes readable JSON with every secret sealed', async () => {
    const file = await exported();
    const text = file.toString('utf8');
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe('cpm-config');
    expect(parsed.tables.proxy_hosts.map((h: { name: string }) => h.name)).toEqual([
      'app',
      'clash',
    ]);
    for (const secret of ['PRIVATE KEY', 'cf-token', BCRYPT, 'hush', 'enc:v1:', 'cpmbak-secret']) {
      expect(text).not.toContain(secret);
    }
    // Instance state stays home.
    expect(parsed.tables.users).toBeUndefined();
    expect(parsed.tables.agents).toBeUndefined();
    expect(parsed.tables.settings.map((s: { key: string }) => s.key)).not.toContain('dashboard');
    expect(parsed.refs.users).toMatchObject({ '1': 'admin@example.com', '2': 'bea@example.com' });
    expect(parsed.refs.agents).toEqual({ '3': 'edge' });
    expect(describeConfigFile(file).counts.proxy_hosts).toBe(2);
  });

  it('exports only the sections asked for, naming what the rest points at', async () => {
    const file = await exported(['hosts']);
    const parsed = JSON.parse(file.toString('utf8'));
    expect(Object.keys(parsed.tables).sort()).toEqual(
      [
        'forward_auth_access',
        'l4_proxy_host_agents',
        'l4_proxy_hosts',
        'mtls_access_rules',
        'proxy_host_agents',
        'proxy_hosts',
      ].sort(),
    );
    expect(parsed.refs.certificates).toEqual({ '6': 'wildcard' });
    expect(parsed.refs.waf_presets).toEqual({ '5': 'wordpress' });
  });

  it('refuses a short passphrase and an empty selection', async () => {
    db = await createTestDb();
    await expect(exportConfig('short')).rejects.toMatchObject({ code: 'backupPassphraseTooShort' });
    await expect(exportConfig(PASSPHRASE, { sections: [] })).rejects.toMatchObject({
      code: 'configNothingSelected',
    });
  });
});

describe('config import', () => {
  it('previews creates and the conflicting domain, writing nothing', async () => {
    const file = await exported();
    db = await createTestDb();
    await seedTarget();
    const preview = await previewConfigImport(file, PASSPHRASE);
    const host = (name: string) =>
      preview.items.find((item) => item.table === 'proxy_hosts' && item.label === name);
    expect(host('app')?.action).toBe('create');
    expect(host('clash')).toMatchObject({
      action: 'skip',
      reason: 'domainConflict',
      values: { domain: 'taken.example.com', host: 'already here' },
    });
    expect(preview.counts.create).toBeGreaterThan(5);
    expect(await db.select().from(schema.proxyHosts)).toHaveLength(1);
  });

  it('applies with every id remapped and secrets re-encrypted, then finds nothing to do', async () => {
    const file = await exported();
    db = await createTestDb();
    await seedTarget();
    await db
      .insert(schema.wafPresets)
      .values({ id: 40, name: 'wordpress', directives: 'old', ...at });

    const result = await applyConfigImport(file, PASSPHRASE, 1);
    expect(
      result.items.find((i) => i.table === 'waf_presets' && i.label === 'wordpress'),
    ).toMatchObject({
      action: 'update',
      fields: ['directives'],
    });

    const [cert] = await db.select().from(schema.certificates);
    expect(decryptSecret(cert.privateKeyPem as string)).toBe('PRIVATE KEY');
    const [list] = await db.select().from(schema.accessLists);
    const [entry] = await db.select().from(schema.accessListEntries);
    expect(entry).toMatchObject({ accessListId: list.id, passwordHash: BCRYPT });

    const [app] = await db
      .select()
      .from(schema.proxyHosts)
      .where(eq(schema.proxyHosts.name, 'app'));
    expect(app).toMatchObject({ certificateId: cert.id, accessListId: list.id, ownerUserId: 7 });
    const meta = JSON.parse(app.meta as string);
    expect(meta.waf.preset_ids).toEqual([40]);
    expect(meta.location_rules[0].access_list_id).toBe(list.id);
    expect(meta.forward_auth.secret).toBe('hush');
    const pins = await db.select().from(schema.proxyHostAgents);
    expect(pins).toEqual([expect.objectContaining({ proxyHostId: app.id, agentId: 11 })]);
    expect(
      await db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.name, 'clash')),
    ).toHaveLength(0);

    const [group] = await db.select().from(schema.groups);
    const members = await db.select().from(schema.groupMembers);
    expect(members.map((m) => m.userId).sort()).toEqual([1, 7]);
    const [grant] = await db.select().from(schema.groupGrants);
    expect(grant).toMatchObject({ groupId: group.id, proxyHostId: app.id });
    const [exclusion] = await db.select().from(schema.wafExclusions);
    expect(exclusion).toMatchObject({ ruleId: 942100, proxyHostId: app.id });

    const settings = new Map(
      (await db.select().from(schema.settings)).map((s) => [s.key, s.value]),
    );
    expect(JSON.parse(settings.get('waf') as string).preset_ids).toEqual([40]);
    expect(settings.has('dashboard')).toBe(false);
    const token = JSON.parse(settings.get('dns_provider') as string).providers.cloudflare.api_token;
    expect(decryptSecret(token)).toBe('cf-token');

    const again = await previewConfigImport(file, PASSPHRASE);
    const acted = again.items.filter((item) => item.action !== 'skip');
    expect(acted).toEqual([]);
  });

  it('skips a host pinned to an agent this instance lacks rather than unpinning it', async () => {
    const file = await exported();
    db = await createTestDb();
    await user(1, 'admin@example.com');
    const preview = await previewConfigImport(file, PASSPHRASE);
    expect(preview.items.find((i) => i.label === 'app')).toMatchObject({
      action: 'skip',
      reason: 'missingReference',
      values: { kind: 'agents', name: 'edge' },
    });
    // Grants and exclusions on it go with it, rather than widening to every host.
    expect(preview.items.find((i) => i.table === 'waf_exclusions')?.action).toBe('skip');
    expect(preview.warnings.some((w) => w.values.missingName === 'bea@example.com')).toBe(true);
  });

  it('refuses a wrong passphrase and a file that is not an export', async () => {
    const file = await exported();
    await expect(previewConfigImport(file, 'wrong passphrase!')).rejects.toMatchObject({
      code: 'configPassphraseWrong',
    });
    await expect(previewConfigImport(Buffer.from('{"a":1}'), PASSPHRASE)).rejects.toMatchObject({
      code: 'configFileNotRecognised',
    });
  });
});

describe('over GraphQL', () => {
  const contextFor = (role: string): GraphQLContext => ({
    viewer: async () => ({ userId: 1, role, authMethod: 'bearer' as const }),
    access: async () => ({
      userId: 1,
      role,
      isAdmin: role === 'admin',
      isOperator: role === 'operator',
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  });

  it('exports, previews and verifies for an administrator only', async () => {
    db = await createTestDb();
    await seedSource();
    const exported = await graphql({
      schema: gqlSchema,
      source: 'mutation ($p: String!) { exportConfig(passphrase: $p, sections: ["security"]) }',
      contextValue: contextFor('admin'),
      variableValues: { p: PASSPHRASE },
    });
    expect(exported.errors).toBeUndefined();
    const file = (exported.data as { exportConfig: string }).exportConfig;
    expect(JSON.parse(Buffer.from(file, 'base64').toString('utf8')).sections).toEqual(['security']);

    const previewed = await graphql({
      schema: gqlSchema,
      source:
        'mutation ($f: String!, $p: String!) { previewConfigImport(file: $f, passphrase: $p) { counts items { table action reason } } }',
      contextValue: contextFor('admin'),
      variableValues: { f: file, p: PASSPHRASE },
    });
    expect(previewed.errors).toBeUndefined();
    expect(
      (previewed.data as { previewConfigImport: { counts: unknown } }).previewConfigImport.counts,
    ).toEqual({
      create: 0,
      update: 0,
      skip: 4,
    });

    const verified = await graphql({
      schema: gqlSchema,
      source: 'mutation { verifyAuditChain { ok checked firstBroken { reason } } }',
      contextValue: contextFor('admin'),
    });
    expect(verified.errors).toBeUndefined();
    expect(verified.data).toMatchObject({ verifyAuditChain: { ok: true, firstBroken: null } });

    const refused = await graphql({
      schema: gqlSchema,
      source: 'mutation { verifyAuditChain { ok } }',
      contextValue: contextFor('operator'),
    });
    expect(refused.errors?.length).toBeGreaterThan(0);
  });
});
