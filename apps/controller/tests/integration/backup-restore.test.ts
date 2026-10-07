/** Secrets must survive a restore onto a deployment with a different encryption key. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../src/lib/db/schema';
import { config } from '../../src/lib/config';
import { decryptSecret, encryptSecret } from '../../src/lib/secrets';
import { describeTables } from '../../src/lib/migration/import';
import {
  BACKUP_NEVER,
  BACKUP_OPTIONAL,
  createBackup,
  describeBackup,
  restoreBackup,
} from '../../src/lib/backup/service';
import { auditEventRow, insertAuditRows } from '../../src/lib/audit';
import { reanchorAuditChain, verifyAuditChain } from '../../src/lib/audit/chain';

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

  it("leaves out the running cluster's state and the stored GeoIP databases", async () => {
    await ctx.db.insert(schema.geoipDatabases).values({
      edition: 'GeoLite2-Country',
      sha256: 'x',
      data: new Uint8Array([1, 2, 3]),
      updatedAt: new Date().toISOString(),
    });
    await ctx.db.insert(schema.spentNonces).values({ key: 'n', expiresAt: Date.now() + 60_000 });
    const summary = describeBackup(await createBackup(PASSPHRASE));
    expect(summary.counts.geoip_databases).toBeUndefined();
    expect(summary.counts.spent_nonces).toBeUndefined();
    expect(summary.counts.agent_connections).toBeUndefined();
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

describe('the audit hash chain across a restore', () => {
  const log = (summary: string) =>
    insertAuditRows([auditEventRow({ action: 'update', entityType: 'proxy_host', summary })]);

  beforeEach(async () => {
    await ctx.db.delete(schema.auditEvents);
    await reanchorAuditChain();
  });

  it('stays verifiable when the backup brings its own audit log', async () => {
    await log('one');
    await log('two');
    const file = await createBackup(PASSPHRASE, { auditLog: true });
    await log('three, made after the backup');
    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    expect(await ctx.db.select().from(schema.auditEvents)).toHaveLength(2);
    await log('after the restore');
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
  });

  it('leaves the local chain alone when the backup has no audit log', async () => {
    await log('one');
    const file = await createBackup(PASSPHRASE);
    await log('two');
    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    await log('three');
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
  });

  it('adopts the hashless events of a backup made before the chain existed', async () => {
    await ctx.db.insert(schema.auditEvents).values({
      action: 'create',
      entityType: 'user',
      createdAt: NOW,
    });
    const file = await createBackup(PASSPHRASE, { auditLog: true });
    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    await log('after');
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 1, legacy: 1 });
  });

  it('re-keys a chain another installation hashed', async () => {
    await ctx.db.insert(schema.auditEvents).values(
      [1, 2].map((seq) => ({
        action: 'update',
        entityType: 'proxy_host',
        createdAt: NOW,
        seq,
        prevHash: seq === 1 ? '0'.repeat(64) : 'a'.repeat(64),
        hash: 'ab'[seq - 1].repeat(64),
      })),
    );
    expect((await verifyAuditChain()).ok).toBe(false);
    const file = await createBackup(PASSPHRASE, { auditLog: true });
    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    await log('after');
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3, legacy: 0 });
  });
});

describe('scheduled backup state across a restore', () => {
  async function seedSchedule() {
    const [destination] = await ctx.db
      .insert(schema.backupDestinations)
      .values({
        name: 'bucket',
        kind: 's3',
        bucket: 'cpm',
        accessKeyId: 'AKIA',
        secretAccessKey: encryptSecret('s3-secret-key'),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    const [schedule] = await ctx.db
      .insert(schema.backupSchedules)
      .values({
        name: 'nightly',
        destinationId: destination.id,
        cron: '0 2 * * *',
        passphrase: encryptSecret('schedule passphrase'),
        scheduledSince: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    await ctx.db.insert(schema.backupRuns).values({
      scheduleId: schedule.id,
      slot: 1,
      trigger: 'schedule',
      status: 'succeeded',
      startedAt: NOW,
    });
    return { destination, schedule };
  }

  beforeEach(async () => {
    await ctx.db.delete(schema.backupRuns);
    await ctx.db.delete(schema.backupSchedules);
    await ctx.db.delete(schema.backupDestinations);
  });

  it('carries destinations and schedules with their secrets as plaintext, and never the runs', async () => {
    await seedSchedule();
    const file = await createBackup(PASSPHRASE);
    const { openBackup } = await import('../../src/lib/backup/format');
    const opened = await openBackup(file, PASSPHRASE);
    expect(opened.tables.backup_runs).toBeUndefined();
    const [destination] = opened.tables.backup_destinations as { secretAccessKey: string }[];
    const [schedule] = opened.tables.backup_schedules as { passphrase: string }[];
    // Sealed by the backup's passphrase only: a target with another SESSION_SECRET can read them.
    expect(destination.secretAccessKey.startsWith('cpmbak-secret:')).toBe(true);
    expect(schedule.passphrase.startsWith('cpmbak-secret:')).toBe(true);
  });

  it("restores them re-encrypted under this deployment's key, dropping the old runs", async () => {
    await seedSchedule();
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.backupRuns);
    await ctx.db.delete(schema.backupSchedules);
    await ctx.db.delete(schema.backupDestinations);
    // A run recorded after the backup, for a schedule id the restore brings back.
    const { schedule } = await seedSchedule();

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });

    const [destination] = await ctx.db.select().from(schema.backupDestinations);
    expect(destination.secretAccessKey.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(destination.secretAccessKey)).toBe('s3-secret-key');
    const [restored] = await ctx.db.select().from(schema.backupSchedules);
    expect(decryptSecret(restored.passphrase)).toBe('schedule passphrase');
    expect(restored.name).toBe(schedule.name);
    expect(await ctx.db.select().from(schema.backupRuns)).toHaveLength(0);
  });
});

describe('host history', () => {
  async function seedRevision(snapshotSecret: string) {
    await ctx.db.delete(schema.hostRevisions);
    await ctx.db.insert(schema.hostRevisions).values({
      hostKind: 'http',
      hostId: 7,
      operation: 'update',
      // A stored secret stays sealed in a snapshot, as the row it copies keeps it.
      snapshot: JSON.stringify({ row: { id: 7, name: 'app', meta: snapshotSecret }, agentIds: [] }),
      userId: 1,
      userName: 'Admin',
      createdAt: NOW,
    });
  }

  it('is in a backup only when settings history is asked for', async () => {
    await seedRevision(encryptSecret('snapshot-secret'));
    const { openBackup } = await import('../../src/lib/backup/format');
    const without = await openBackup(await createBackup(PASSPHRASE), PASSPHRASE);
    expect(without.tables.host_revisions).toBeUndefined();
    const withHistory = await openBackup(
      await createBackup(PASSPHRASE, { settingsHistory: true }),
      PASSPHRASE,
    );
    expect(withHistory.tables.host_revisions).toHaveLength(1);
    expect(JSON.stringify(withHistory.tables.host_revisions)).not.toContain('enc:v1:');
  });

  it('restores re-sealed, and clears revisions a restore of hosts without them would misname', async () => {
    await seedRevision(encryptSecret('snapshot-secret'));
    const withHistory = await createBackup(PASSPHRASE, { settingsHistory: true });
    await ctx.db.delete(schema.hostRevisions);
    await restoreBackup(withHistory, PASSPHRASE, { keepAgents: true });
    const [restored] = await ctx.db.select().from(schema.hostRevisions);
    const meta = JSON.parse(restored.snapshot).row.meta as string;
    expect(meta.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(meta)).toBe('snapshot-secret');

    const hostsOnly = await createBackup(PASSPHRASE);
    await restoreBackup(hostsOnly, PASSPHRASE, { keepAgents: true });
    expect(await ctx.db.select().from(schema.hostRevisions)).toHaveLength(0);
  });
});

describe('older backup formats', () => {
  it('restores a version 2 backup', async () => {
    const { readFileSync } = await import('node:fs');
    const file = readFileSync(join(import.meta.dir, '../unit/backup/v2-fixture.cpmbak'));
    await restoreBackup(file, 'version two passphrase', { keepAgents: true });
    const hosts = await ctx.db.select().from(schema.proxyHosts);
    expect(hosts.map((host) => host.name)).toEqual(['from-v2']);
  });
});

describe('alerting across a restore', () => {
  async function seedAlerts() {
    const [channel] = await ctx.db
      .insert(schema.notificationChannels)
      .values({
        name: 'ops-chat',
        kind: 'discord',
        secret: encryptSecret(JSON.stringify({ url: 'https://discord.test/api/webhooks/1/token' })),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    const [rule] = await ctx.db
      .insert(schema.alertRules)
      .values({
        name: 'errors',
        source: 'metric',
        channelIds: JSON.stringify([channel.id]),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    const [event] = await ctx.db
      .insert(schema.alertEvents)
      .values({
        key: 'k',
        ruleId: rule.id,
        kind: 'test',
        severity: 'info',
        type: 'notice',
        event: '{"kind":"test"}',
        at: NOW,
      })
      .returning();
    await ctx.db
      .insert(schema.alertDeliveries)
      .values({ eventId: event.id, channelId: channel.id, createdAt: NOW, updatedAt: NOW });
    return { channel, rule };
  }

  beforeEach(async () => {
    await ctx.db.delete(schema.alertDeliveries);
    await ctx.db.delete(schema.alertEvents);
    await ctx.db.delete(schema.alertRules);
    await ctx.db.delete(schema.notificationChannels);
  });

  it('keeps channels and rules, secrets re-encrypted, and leaves the history behind', async () => {
    const { channel, rule } = await seedAlerts();
    const file = await createBackup(PASSPHRASE);
    const { openBackup } = await import('../../src/lib/backup/format');
    const opened = await openBackup(file, PASSPHRASE);
    expect(opened.tables.alert_events).toBeUndefined();
    expect(opened.tables.alert_deliveries).toBeUndefined();
    const [carried] = opened.tables.notification_channels as { secret: string }[];
    expect(carried.secret.startsWith('cpmbak-secret:')).toBe(true);

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    const [restored] = await ctx.db.select().from(schema.notificationChannels);
    expect(restored.id).toBe(channel.id);
    expect(JSON.parse(decryptSecret(restored.secret))).toEqual({
      url: 'https://discord.test/api/webhooks/1/token',
    });
    const [restoredRule] = await ctx.db.select().from(schema.alertRules);
    expect(JSON.parse(restoredRule.channelIds)).toEqual([channel.id]);
    expect(restoredRule.id).toBe(rule.id);
  });
});

describe('audit streaming across a restore', () => {
  beforeEach(async () => {
    await ctx.db.delete(schema.auditSinks);
    await ctx.db.delete(schema.auditSecurityRecords);
    await ctx.db.delete(schema.auditSecurityHead);
  });

  it('keeps sinks, secrets re-encrypted, and leaves the queued security records behind', async () => {
    const secret = { url: 'https://siem.test/hec', headerValue: 'Splunk token-1' };
    const [sink] = await ctx.db
      .insert(schema.auditSinks)
      .values({
        name: 'siem',
        kind: 'http',
        config: JSON.stringify({ encoding: 'gzip' }),
        secret: encryptSecret(JSON.stringify(secret)),
        includeSecurity: true,
        auditCursor: 3,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    await ctx.db
      .insert(schema.auditSecurityRecords)
      .values({ seq: 1, record: '{}', createdAt: NOW });
    await ctx.db
      .insert(schema.auditSecurityHead)
      .values({ id: 1, headSeq: 1, prunedSeq: 0, updatedAt: NOW });

    const file = await createBackup(PASSPHRASE);
    const { openBackup } = await import('../../src/lib/backup/format');
    const opened = await openBackup(file, PASSPHRASE);
    expect(opened.tables.audit_security_records).toBeUndefined();
    expect(opened.tables.audit_security_head).toBeUndefined();
    const [carried] = opened.tables.audit_sinks as { secret: string }[];
    expect(carried.secret.startsWith('cpmbak-secret:')).toBe(true);

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    const [restored] = await ctx.db.select().from(schema.auditSinks);
    expect(restored).toMatchObject({ id: sink.id, auditCursor: 3, includeSecurity: true });
    expect(JSON.parse(decryptSecret(restored.secret))).toEqual(secret);
  });
});

describe('roles across a restore', () => {
  async function seedRoles() {
    await ctx.db.delete(schema.roleMappings);
    await ctx.db.delete(schema.oauthProviders);
    await ctx.db.delete(schema.roles);
    await ctx.db.insert(schema.roles).values({
      key: 'role-0123456789ab',
      name: 'Auditors',
      capabilities: '["audit:read"]',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert(schema.oauthProviders).values({
      id: 'idp',
      name: 'IdP',
      clientId: encryptSecret('c'),
      clientSecret: encryptSecret('s'),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert(schema.roleMappings).values([
      { providerId: 'idp', role: 'admin', externalName: 'admins', createdAt: NOW },
      { providerId: 'idp', role: 'role-0123456789ab', externalName: 'audit', createdAt: NOW },
    ]);
  }

  const mappings = async () =>
    (await ctx.db.select().from(schema.roleMappings)).map((row) => [row.role, row.externalName]);

  it('keeps made roles and every role mapping', async () => {
    await seedRoles();
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.roleMappings);
    await ctx.db.delete(schema.roles);
    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    expect((await ctx.db.select().from(schema.roles)).map((row) => row.name)).toEqual(['Auditors']);
    expect(await mappings()).toEqual([
      ['admin', 'admins'],
      ['role-0123456789ab', 'audit'],
    ]);
  });

  it('turns the role columns of a backup from before role mappings into rows', async () => {
    await seedRoles();
    const { openBackup, sealBackup } = await import('../../src/lib/backup/format');
    const opened = await openBackup(await createBackup(PASSPHRASE), PASSPHRASE);
    // What a backup made before the move carries: the lists on the provider, no mapping table.
    const tables = { ...opened.tables };
    delete tables.role_mappings;
    tables.oauth_providers = (tables.oauth_providers as Record<string, unknown>[]).map((row) => ({
      ...row,
      adminGroup: 'owners, admins',
      operatorGroup: null,
      userGroup: 'staff',
      viewerGroup: '',
    }));
    const legacy = await sealBackup({ ...opened, tables }, PASSPHRASE, {
      appVersion: opened.header.appVersion,
    });
    await restoreBackup(legacy, PASSPHRASE, { keepAgents: true });
    expect(await mappings()).toEqual([
      ['admin', 'owners'],
      ['admin', 'admins'],
      ['user', 'staff'],
    ]);
  });
});

describe('SAML providers across a restore', () => {
  it('keeps both halves of a provider, its metadata as saved', async () => {
    await ctx.db.delete(schema.ssoProviders);
    await ctx.db.delete(schema.oauthProviders);
    await ctx.db.insert(schema.oauthProviders).values({
      id: 'saml-idp',
      name: 'SAML IdP',
      type: 'saml',
      clientId: encryptSecret(''),
      clientSecret: encryptSecret(''),
      issuer: 'https://idp.example.com/metadata',
      scopes: '',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const samlConfig = JSON.stringify({
      issuer: 'https://cpm.example.com/sp',
      idpMetadata: { metadata: '<md:EntityDescriptor/>' },
      wantAssertionsSigned: true,
    });
    await ctx.db.insert(schema.ssoProviders).values({
      issuer: 'https://cpm.example.com/sp',
      samlConfig,
      providerId: 'saml-idp',
      domain: 'example.com',
    });
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.oauthProviders);
    expect(await ctx.db.select().from(schema.ssoProviders)).toHaveLength(0);

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    const [restored] = await ctx.db.select().from(schema.ssoProviders);
    expect(restored).toMatchObject({
      providerId: 'saml-idp',
      issuer: 'https://cpm.example.com/sp',
      samlConfig,
      domain: 'example.com',
      domainVerified: true,
    });
    const [provider] = await ctx.db
      .select()
      .from(schema.oauthProviders)
      .where(eq(schema.oauthProviders.id, 'saml-idp'));
    expect(provider.type).toBe('saml');
    // Re-sealed under this deployment's key, like any provider's.
    expect(decryptSecret(provider.clientSecret)).toBe('');
  });
});

describe('SCIM connections across a restore', () => {
  it('keeps a connection, its mapping and what it provisioned', async () => {
    await ctx.db.delete(schema.scimConnections);
    const [connection] = await ctx.db
      .insert(schema.scimConnections)
      .values({
        name: 'Backed up IdP',
        tokenHash: 'a'.repeat(64),
        tokenHint: 'abcd',
        linkExisting: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    await ctx.db.insert(schema.scimRoleMappings).values({
      connectionId: connection.id,
      role: 'viewer',
      externalName: 'Readers',
      createdAt: NOW,
    });
    await ctx.db.insert(schema.scimGroups).values({
      connectionId: String(connection.id),
      provisioningDomainId: 'cpm',
      displayName: 'Readers',
      displayNameKey: 'cpm:readers',
      orderKey: 'order-1',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.scimGroups);
    await ctx.db.delete(schema.scimConnections);

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    const [restored] = await ctx.db.select().from(schema.scimConnections);
    expect(restored).toMatchObject({
      name: 'Backed up IdP',
      tokenHash: 'a'.repeat(64),
      linkExisting: false,
    });
    expect(await ctx.db.select().from(schema.scimRoleMappings)).toHaveLength(1);
    const [group] = await ctx.db.select().from(schema.scimGroups);
    expect(group).toMatchObject({ displayName: 'Readers', connectionId: String(connection.id) });
  });
});

describe('access reviews across a restore', () => {
  it('keeps a campaign and its decisions, the record of who reviewed what', async () => {
    await ctx.db.delete(schema.accessReviewCampaigns);
    const [campaign] = await ctx.db
      .insert(schema.accessReviewCampaigns)
      .values({
        name: 'Backed up review',
        scope: 'tokens',
        dueOn: '2026-12-31',
        status: 'closed',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    await ctx.db.insert(schema.accessReviewItems).values({
      campaignId: campaign.id,
      kind: 'token',
      subjectLabel: 'ci',
      targetLabel: 'owner@example.com',
      hints: '["tokenUnused"]',
      decision: 'revoke',
      note: 'unused',
      outcome: 'applied',
    });
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.accessReviewCampaigns);

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    const [restored] = await ctx.db.select().from(schema.accessReviewCampaigns);
    expect(restored).toMatchObject({ name: 'Backed up review', status: 'closed' });
    const [item] = await ctx.db.select().from(schema.accessReviewItems);
    expect(item).toMatchObject({
      campaignId: restored.id,
      subjectLabel: 'ci',
      decision: 'revoke',
      note: 'unused',
      outcome: 'applied',
    });
  });
});

describe('change requests across a restore', () => {
  it('keeps a request, its sealed write and its decisions, the record of who approved what', async () => {
    await ctx.db.delete(schema.changeRequests);
    const [request] = await ctx.db
      .insert(schema.changeRequests)
      .values({
        kind: 'proxyHostUpdate',
        area: 'hosts',
        targetType: 'proxyHost',
        targetId: 7,
        targetName: 'shop',
        payload: encryptSecret(JSON.stringify({ id: 7, input: { name: 'store' } })),
        preview: '{"type":"fields","changes":[]}',
        baseState: 'abc',
        status: 'applied',
        createdAt: NOW,
      })
      .returning();
    await ctx.db.insert(schema.changeRequestDecisions).values({
      requestId: request.id,
      userName: 'Bob',
      decision: 'approve',
      note: 'fine',
      createdAt: NOW,
    });
    const file = await createBackup(PASSPHRASE);
    await ctx.db.delete(schema.changeRequests);

    await restoreBackup(file, PASSPHRASE, { keepAgents: true });
    const [restored] = await ctx.db.select().from(schema.changeRequests);
    expect(restored).toMatchObject({
      kind: 'proxyHostUpdate',
      targetName: 'shop',
      status: 'applied',
    });
    expect(JSON.parse(decryptSecret(restored.payload))).toEqual({
      id: 7,
      input: { name: 'store' },
    });
    const [decision] = await ctx.db.select().from(schema.changeRequestDecisions);
    expect(decision).toMatchObject({
      requestId: restored.id,
      userName: 'Bob',
      decision: 'approve',
    });
  });
});
