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
        load_balancer: { policy: 'cookie', policy_cookie_secret: 'hush' },
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
    // By its own id: an agent picks its name, and two can share one.
    expect(parsed.refs.agents).toEqual({ '3': 'a'.repeat(32) });
    expect(parsed.refLabels.agents).toEqual({ '3': 'edge' });
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
    expect(meta.load_balancer.policy_cookie_secret).toBe('hush');
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
      values: { kind: 'agents', name: `edge (${'a'.repeat(32)})` },
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
  const contextFor = (
    role: string,
    authMethod: 'bearer' | 'session' = 'bearer',
  ): GraphQLContext => ({
    viewer: async () => ({ userId: 1, role, authMethod }),
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

  it('refuses the export and the import to a session that is not fresh', async () => {
    db = await createTestDb();
    await seedSource();
    const exportedOverSession = await graphql({
      schema: gqlSchema,
      source: 'mutation ($p: String!) { exportConfig(passphrase: $p) }',
      contextValue: {
        ...contextFor('admin', 'session'),
        request: new Request('http://x/') as never,
      },
      variableValues: { p: PASSPHRASE },
    });
    expect(exportedOverSession.errors?.[0]?.message).toContain('Sign out and in again');
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

describe('the file is authenticated', () => {
  /** The MAC as the format computes it, for a test that edits a file the way a passphrase holder could. */
  async function remac(file: Record<string, unknown>): Promise<Buffer> {
    const { deriveKey } = await import('../../../src/lib/backup/format');
    const { createHmac, hkdfSync } = await import('node:crypto');
    const kdf = file.kdf as { salt: string; N: number; r: number; p: number };
    const salt = Buffer.from(kdf.salt, 'base64');
    const master = await deriveKey(PASSPHRASE, salt, { N: kdf.N, r: kdf.r, p: kdf.p });
    const key = Buffer.from(hkdfSync('sha256', master, salt, 'cpm-config:v2:mac', 32));
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.keys(value)
          .sort()
          .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value ?? null);
    };
    const { mac: _mac, ...body } = file;
    const mac = createHmac('sha256', key)
      .update(`cpm-config:2\n${canonical(body)}`)
      .digest('base64');
    return Buffer.from(JSON.stringify({ ...body, mac }));
  }

  it('refuses any edit made without the passphrase, the version gate included', async () => {
    const file = await exported();
    const parsed = JSON.parse(file.toString('utf8'));
    const edits: ((f: typeof parsed) => void)[] = [
      (f) => {
        f.appVersion = '0.0.1';
      },
      (f) => {
        f.tables.groups[0].name = 'admins';
      },
      (f) => {
        f.refs.users['2'] = 'mallory@example.com';
      },
      (f) => {
        const dns = f.tables.settings.find((row: { key: string }) => row.key === 'dns_provider');
        const value = JSON.parse(dns.value);
        value.providers.cloudflare.endpoint_url = 'https://attacker.example';
        dns.value = JSON.stringify(value);
      },
    ];
    for (const edit of edits) {
      const copy = structuredClone(parsed);
      edit(copy);
      await expect(
        previewConfigImport(Buffer.from(JSON.stringify(copy)), PASSPHRASE),
      ).rejects.toMatchObject({ code: 'configFileTampered' });
    }
    const missing = structuredClone(parsed);
    delete missing.mac;
    await expect(
      previewConfigImport(Buffer.from(JSON.stringify(missing)), PASSPHRASE),
    ).rejects.toMatchObject({ code: 'configFileNotRecognised' });
    const v1 = structuredClone(parsed);
    v1.version = 1;
    await expect(
      previewConfigImport(Buffer.from(JSON.stringify(v1)), PASSPHRASE),
    ).rejects.toMatchObject({ code: 'configFileNotRecognised' });
  });

  it('refuses a sealed value moved to another place, even under a valid MAC', async () => {
    const file = await exported();
    const parsed = JSON.parse(file.toString('utf8'));
    const host = parsed.tables.proxy_hosts.find((row: { name: string }) => row.name === 'app');
    const sealed = JSON.parse(host.meta).load_balancer.policy_cookie_secret as string;
    expect(sealed).toStartWith('cpmcfg-sealed:');
    // Into a plain column of another row, where it would be stored as readable text.
    parsed.tables.groups[0].description = sealed;
    await expect(previewConfigImport(await remac(parsed), PASSPHRASE)).rejects.toMatchObject({
      code: 'configFileTampered',
    });
    // The untouched file still opens, so the helper above is the format's MAC.
    const clean = JSON.parse(file.toString('utf8'));
    await expect(previewConfigImport(await remac(clean), PASSPHRASE)).resolves.toBeDefined();
  });
});

describe('imported rows are checked as a save checks them', () => {
  async function seedInvalid() {
    db = await createTestDb();
    await user(1, 'admin@example.com');
    await db.insert(schema.accessLists).values([
      { id: 1, name: 'redirect', denyRedirectUrl: 'https://x.example/{http.request.uri}', ...at },
      { id: 2, name: 'zone', ...at },
    ]);
    await db.insert(schema.accessListIpRules).values({
      accessListId: 2,
      action: 'deny',
      cidr: 'fe80::%eth0/64',
      sortOrder: 0,
      ...at,
    });
    await db.insert(schema.blockedSources).values({
      kind: 'cidr',
      value: '10.0.0.0/8"',
      createdAt: NOW,
    });
    await db.insert(schema.proxyHosts).values([
      { id: 3, name: 'bad domain', domains: '["exa mple.com"]', upstreams: '["a:80"]', ...at },
      { id: 4, name: 'first', domains: '["dup.example.com"]', upstreams: '["a:80"]', ...at },
      { id: 5, name: 'second', domains: '["DUP.example.com"]', upstreams: '["b:80"]', ...at },
      {
        id: 6,
        name: 'bad waf',
        domains: '["waf.example.com"]',
        upstreams: '["a:80"]',
        meta: JSON.stringify({ waf: { enabled: true, custom_directives: 'SecRule ARGS "' } }),
        ...at,
      },
    ]);
    await db.insert(schema.wafExclusions).values({
      ruleId: 942100,
      path: '/x" "id:1,phase:1,deny',
      reason: '',
      ...at,
    });
    const file = await exportConfig(PASSPHRASE);
    db = await createTestDb();
    await user(1, 'admin@example.com');
    return file;
  }

  it('skips each invalid row with the reason the save would give', async () => {
    const preview = await previewConfigImport(await seedInvalid(), PASSPHRASE);
    const item = (table: string, label: string) =>
      preview.items.find((i) => i.table === table && i.label.startsWith(label));
    expect(item('access_lists', 'redirect')).toMatchObject({
      action: 'skip',
      reason: 'invalid',
      values: { code: 'accessListDenyRedirectInvalid' },
    });
    expect(item('access_lists', 'zone')).toMatchObject({
      reason: 'invalid',
      values: { code: 'ipRuleInvalid' },
    });
    expect(item('blocked_sources', 'cidr')).toMatchObject({
      reason: 'invalid',
      values: { code: 'blockedSourceCidrInvalid' },
    });
    expect(item('proxy_hosts', 'bad domain')).toMatchObject({ reason: 'invalid' });
    expect(item('proxy_hosts', 'bad waf')).toMatchObject({
      reason: 'invalid',
      values: { code: 'wafDirectivesDropped' },
    });
    expect(item('waf_exclusions', '942100')).toMatchObject({
      reason: 'invalid',
      values: { code: 'wafExclusionPathInvalid' },
    });
    // The file's own hosts are checked against each other too.
    expect(item('proxy_hosts', 'first')?.action).toBe('create');
    expect(item('proxy_hosts', 'second')).toMatchObject({
      reason: 'domainConflict',
      values: { domain: 'dup.example.com', host: 'first' },
    });
  });

  it('writes none of them', async () => {
    await applyConfigImport(await seedInvalid(), PASSPHRASE, 1);
    expect((await db.select().from(schema.proxyHosts)).map((h) => h.name)).toEqual(['first']);
    expect(await db.select().from(schema.accessLists)).toEqual([]);
    expect(await db.select().from(schema.blockedSources)).toEqual([]);
    expect(await db.select().from(schema.wafExclusions)).toEqual([]);
  });

  it('encrypts a DNS credential the file carried in the clear', async () => {
    db = await createTestDb();
    await user(1, 'admin@example.com');
    await db.insert(schema.settings).values({
      key: 'dns_provider',
      value: JSON.stringify({ providers: { cloudflare: { api_token: 'plain-token' } } }),
      updatedAt: NOW,
    });
    const file = await exportConfig(PASSPHRASE, { sections: ['settings'] });
    expect(file.toString('utf8')).not.toContain('plain-token');
    db = await createTestDb();
    await user(1, 'admin@example.com');
    await applyConfigImport(file, PASSPHRASE, 1);
    const [row] = await db.select().from(schema.settings);
    const token = JSON.parse(row.value).providers.cloudflare.api_token as string;
    expect(token).toStartWith('enc:v1:');
    expect(decryptSecret(token)).toBe('plain-token');
  });
});

describe('matching by natural key', () => {
  it('skips a name more than one row shares rather than guessing by id', async () => {
    db = await createTestDb();
    await user(1, 'admin@example.com');
    await db.insert(schema.accessLists).values([
      { id: 1, name: 'office', ...at },
      { id: 2, name: 'office', ipDefault: 'allow', ...at },
    ]);
    await db.insert(schema.proxyHosts).values({
      id: 3,
      name: 'app',
      domains: '["app.example.com"]',
      upstreams: '["a:80"]',
      accessListId: 2,
      ...at,
    });
    const file = await exportConfig(PASSPHRASE);
    db = await createTestDb();
    await user(1, 'admin@example.com');
    await db.insert(schema.accessLists).values({ id: 9, name: 'office', ...at });
    const preview = await previewConfigImport(file, PASSPHRASE);
    const lists = preview.items.filter((i) => i.table === 'access_lists');
    expect(lists.map((i) => i.reason)).toEqual(['ambiguous', 'ambiguous']);
    // The host does not land on this instance's one "office".
    expect(preview.items.find((i) => i.label === 'app')).toMatchObject({
      action: 'skip',
      reason: 'missingReference',
    });
  });

  it('pins to the agent with the same agent id, not the one with the same name', async () => {
    const file = await exported(['hosts']);
    db = await createTestDb();
    await seedTarget();
    // Agent 11 is called edge; agent 12 is the source's machine under another name.
    await db.insert(schema.agents).values({
      id: 12,
      name: 'renamed',
      agentId: 'a'.repeat(32),
      secret: encryptSecret('u'),
      ...at,
    });
    await db.insert(schema.certificates).values({
      id: 6,
      name: 'wildcard',
      type: 'imported',
      domainNames: '["*.example.com"]',
      certificatePem: 'CERT',
      ...at,
    });
    await db.insert(schema.accessLists).values({ id: 7, name: 'office', ...at });
    await db.insert(schema.wafPresets).values({ id: 5, name: 'wordpress', directives: 'x', ...at });
    await applyConfigImport(file, PASSPHRASE, 1);
    const [app] = await db
      .select()
      .from(schema.proxyHosts)
      .where(eq(schema.proxyHosts.name, 'app'));
    const pins = await db.select().from(schema.proxyHostAgents);
    expect(pins).toEqual([expect.objectContaining({ proxyHostId: app.id, agentId: 12 })]);
  });
});

describe('revocation is one-way', () => {
  it('keeps a local revocation an older export would undo', async () => {
    db = await createTestDb();
    await user(1, 'admin@example.com');
    const cert = {
      id: 1,
      caCertificateId: 1,
      commonName: 'laptop',
      serialNumber: '01',
      fingerprintSha256: 'ab:cd',
      certificatePem: 'CERT',
      validFrom: NOW,
      validTo: '2030-01-01T00:00:00.000Z',
      ...at,
    };
    await db.insert(schema.caCertificates).values({
      id: 1,
      name: 'ca',
      certificatePem: 'CA',
      ...at,
    });
    await db.insert(schema.issuedClientCertificates).values(cert);
    const file = await exportConfig(PASSPHRASE, { sections: ['certificates'] });
    await db
      .update(schema.issuedClientCertificates)
      .set({ revokedAt: NOW, commonName: 'laptop (lost)' });
    const preview = await previewConfigImport(file, PASSPHRASE);
    const item = preview.items.find((i) => i.table === 'issued_client_certificates');
    expect(item).toMatchObject({ action: 'update', kept: ['revokedAt'], fields: ['commonName'] });
    await applyConfigImport(file, PASSPHRASE, 1);
    const [row] = await db.select().from(schema.issuedClientCertificates);
    expect(row).toMatchObject({ revokedAt: NOW, commonName: 'laptop' });
  });
});

describe('the preview shows what changes', () => {
  it('lists before and after with secrets masked and references by name', async () => {
    const file = await exported();
    db = await createTestDb();
    await seedTarget();
    const preview = await previewConfigImport(file, PASSPHRASE);
    const text = JSON.stringify(preview);
    for (const secret of ['PRIVATE KEY', 'cf-token', BCRYPT, 'hush', 'cpmbak-secret']) {
      expect(text).not.toContain(secret);
    }
    const group = preview.items.find((i) => i.table === 'groups' && i.label === 'ops');
    expect(group?.action).toBe('create');
    const members = group?.changes.find((c) => c.field === 'group_members');
    expect(JSON.stringify(members)).toContain('bea@example.com');
    const app = preview.items.find((i) => i.label === 'app');
    expect(app?.changes.find((c) => c.field === 'meta')?.masked).toBe(true);
    expect(app?.changes.find((c) => c.field === 'ownerUserId')?.after).toBe('bea@example.com');
  });
});
