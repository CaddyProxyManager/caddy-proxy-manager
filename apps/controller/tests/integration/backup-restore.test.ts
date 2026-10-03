/** Secrets must survive a restore onto a deployment with a different encryption key. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  runInTransaction: async (build: (tx: TestDb) => unknown[]) => {
    for (const statement of build(ctx.db)) await statement;
  },
}));

import * as schema from '../../src/lib/db/schema';
import { config } from '../../src/lib/config';
import { decryptSecret, encryptSecret } from '../../src/lib/secret';
import { describeTables } from '../../src/lib/migration/import';
import {
  BACKUP_NEVER,
  BACKUP_OPTIONAL,
  createBackup,
  describeBackup,
  restoreBackup,
} from '../../src/lib/backup/service';

const PASSPHRASE = 'correct horse battery staple';
const NOW = new Date().toISOString();
const dataDir = mkdtempSync(join(tmpdir(), 'cpm-backup-'));
process.env.L4_PORTS_DIR = dataDir;

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

async function seed() {
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@localhost',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    twoFactorEnabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert(schema.twoFactors).values({
    userId: 1,
    secret: await symmetricEncrypt({ key: config.sessionSecret, data: 'TOTPSECRET' }),
    backupCodes: await symmetricEncrypt({ key: config.sessionSecret, data: '["aaaaa-11111"]' }),
    verified: true,
  });
  // Not a secret, but lost with the users it belongs to unless backed up alongside them.
  await ctx.db.insert(schema.passkeys).values({
    userId: 1,
    name: 'Laptop',
    publicKey: 'pQECAyYgASFYIA',
    credentialID: 'credential-1',
    counter: 4,
    deviceType: 'multiDevice',
    backedUp: true,
    transports: 'internal,hybrid',
    createdAt: NOW,
  });
  await ctx.db.insert(schema.settings).values({
    key: 'dns_provider',
    value: JSON.stringify({ providers: { cloudflare: { api_token: encryptSecret('cf-token') } } }),
    updatedAt: NOW,
  });
  await ctx.db.insert(schema.proxyHosts).values({
    id: 7,
    name: 'app',
    domains: '["app.example.com"]',
    upstreams: '["app:80"]',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert(schema.agents).values({
    id: 3,
    name: 'edge',
    agentId: 'a'.repeat(32),
    secret: encryptSecret('agent-secret'),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert(schema.sessions).values({
    userId: 1,
    token: 'live-session',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  for (const table of [
    schema.sessions,
    schema.twoFactors,
    schema.passkeys,
    schema.certificates,
    schema.agents,
    schema.proxyHosts,
    schema.settings,
    schema.users,
  ]) {
    await ctx.db.delete(table);
  }
  await seed();
});

describe('backup contents', () => {
  it('decides for every table whether it is backed up', () => {
    const decided = new Set<string>([...BACKUP_NEVER, ...Object.values(BACKUP_OPTIONAL)]);
    // Everything else is backed up by default, so this only has to catch a name that no longer
    // exists in the lists above - a renamed table silently becoming "backed up".
    const names = new Set(describeTables().map((table) => table.name));
    for (const name of decided) expect(names.has(name), name).toBe(true);
  });

  it('carries the plaintext of every secret, sealed, and none of the live sessions', async () => {
    const file = await createBackup(PASSPHRASE);
    const text = file.toString('utf8');
    expect(text).not.toContain('cf-token');
    expect(text).not.toContain('enc:v1:');
    const summary = describeBackup(file);
    expect(summary.counts.proxy_hosts).toBe(1);
    expect(summary.counts.sessions).toBeUndefined();
  });

  it('refuses a short passphrase', async () => {
    await expect(createBackup('short')).rejects.toMatchObject({ code: 'backupPassphraseTooShort' });
  });
});

describe('restore', () => {
  it('puts everything back, re-encrypted, and signs everyone out', async () => {
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.proxyHosts);
    await ctx.db.delete(schema.passkeys);
    await ctx.db
      .update(schema.settings)
      .set({ value: '{}' })
      .where(eq(schema.settings.key, 'dns_provider'));

    const result = await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    expect(result.rows).toBeGreaterThan(0);

    expect(await ctx.db.select().from(schema.proxyHosts)).toHaveLength(1);
    expect(await ctx.db.select().from(schema.sessions)).toHaveLength(0);

    const [setting] = await ctx.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, 'dns_provider'));
    const token = JSON.parse(setting.value).providers.cloudflare.api_token;
    expect(decryptSecret(token)).toBe('cf-token');

    const [agent] = await ctx.db.select().from(schema.agents);
    expect(decryptSecret(agent.secret)).toBe('agent-secret');

    const [factor] = await ctx.db.select().from(schema.twoFactors);
    expect(await symmetricDecrypt({ key: config.sessionSecret, data: factor.secret })).toBe(
      'TOTPSECRET',
    );

    const [passkey] = await ctx.db.select().from(schema.passkeys);
    expect(passkey).toMatchObject({ userId: 1, credentialID: 'credential-1', counter: 4 });

    // The state it replaced was saved first.
    expect(readdirSync(join(dataDir, 'backups')).some((f) => f.endsWith('.cpmbak'))).toBe(true);
  });

  it('closes live agent streams the restored agents table no longer vouches for', async () => {
    const { attach, isConnected, resetRegistry } = await import('../../src/lib/agent/registry');
    const { agentCredentialFingerprint, reconcileAgentConnections } = await import(
      '../../src/lib/models/agents'
    );
    const file = await createBackup(PASSPHRASE);
    // After the backup: agent 3 re-paired with a new secret, and a second agent paired.
    await ctx.db
      .update(schema.agents)
      .set({ secret: encryptSecret('re-paired-secret') })
      .where(eq(schema.agents.id, 3));
    await ctx.db.insert(schema.agents).values({
      id: 4,
      name: 'new',
      agentId: 'b'.repeat(32),
      secret: encryptSecret('new-agent-secret'),
      createdAt: NOW,
      updatedAt: NOW,
    });
    resetRegistry();
    const open = (agentId: string, agentRowId: number, secret: string) =>
      attach({
        agentId,
        agentRowId,
        credential: agentCredentialFingerprint(secret),
        name: agentId.slice(0, 4),
        controllerId: 'controller',
        controllerName: 'CPM',
        initialState: {} as Parameters<typeof attach>[0]['initialState'],
      });
    const repaired = open('a'.repeat(32), 3, 're-paired-secret');
    open('b'.repeat(32), 4, 'new-agent-secret');

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    const closed = await reconcileAgentConnections();

    expect(closed.sort()).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    expect(isConnected('a'.repeat(32))).toBe(false);
    expect(isConnected('b'.repeat(32))).toBe(false);
    // Drain what attach queued; the stream then ends instead of waiting for restored state.
    const seen: string[] = [];
    for await (const event of repaired.events) seen.push(event.type);
    expect(seen).not.toContain('command');
    resetRegistry();
  });

  it('keeps a stream whose agent and secret the restore left as they were', async () => {
    const { attach, isConnected, resetRegistry } = await import('../../src/lib/agent/registry');
    const { agentCredentialFingerprint, reconcileAgentConnections } = await import(
      '../../src/lib/models/agents'
    );
    const file = await createBackup(PASSPHRASE);
    resetRegistry();
    attach({
      agentId: 'a'.repeat(32),
      agentRowId: 3,
      credential: agentCredentialFingerprint('agent-secret'),
      name: 'edge',
      controllerId: 'controller',
      controllerName: 'CPM',
      initialState: {} as Parameters<typeof attach>[0]['initialState'],
    });
    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    expect(await reconcileAgentConnections()).toEqual([]);
    expect(isConnected('a'.repeat(32))).toBe(true);
    resetRegistry();
  });

  it('drops agent pairings when asked, for a restore onto a new machine', async () => {
    const file = await createBackup(PASSPHRASE);
    await restoreBackup(file, PASSPHRASE, { keepAgents: false });
    // Left as they are here, rather than replaced by the backup's.
    expect(await ctx.db.select().from(schema.agents)).toHaveLength(1);
  });

  it("keeps a certificate read from an agent's files, unlinked, when pairings are dropped", async () => {
    await ctx.db.insert(schema.certificates).values({
      name: 'from-files',
      type: 'imported',
      domainNames: '["app.example.com"]',
      source: 'agent-file',
      sourceAgentId: 3,
      sourceCertPath: 'live/app/fullchain.pem',
      sourceKeyPath: 'live/app/privkey.pem',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const file = await createBackup(PASSPHRASE);
    await restoreBackup(file, PASSPHRASE, { keepAgents: false });
    // The agent id is the old machine's; here it could name a different agent.
    const [cert] = await ctx.db.select().from(schema.certificates);
    expect(cert).toMatchObject({ name: 'from-files', source: 'agent-file', sourceAgentId: null });
  });

  it('changes nothing on a wrong passphrase or a tampered file', async () => {
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.proxyHosts);
    await expect(
      restoreBackup(file, 'not the passphrase', { keepAgents: true }),
    ).rejects.toMatchObject({
      code: 'backupPassphraseWrong',
    });
    const tampered = Buffer.from(file);
    tampered[tampered.length - 5] ^= 1;
    await expect(restoreBackup(tampered, PASSPHRASE, { keepAgents: true })).rejects.toMatchObject({
      code: 'backupPassphraseWrong',
    });
    expect(await ctx.db.select().from(schema.proxyHosts)).toHaveLength(0);
  });

  it('refuses a backup from a newer version', async () => {
    const file = await createBackup(PASSPHRASE);
    const text = file.toString('utf8').replace(/"appVersion":"[^"]+"/, '"appVersion":"999.0.0"');
    await expect(
      restoreBackup(Buffer.from(text, 'utf8'), PASSPHRASE, { keepAgents: true }),
    ).rejects.toMatchObject({ code: 'backupFromNewerVersion' });
  });
});
