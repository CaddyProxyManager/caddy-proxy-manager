/**
 * Certificates read from files on an agent's host. An agent is less trusted than the controller, so
 * most of this is about what it cannot do: write another agent's certificate, store a key that is
 * not the certificate's, or get its key into another agent's config.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { AgentCommand, CertificateFileResult } from '@cpm/shared';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

import { eq } from 'drizzle-orm';
import { logAuditEvent } from '../../src/lib/audit';
import * as schema from '../../src/lib/db/schema';
import { agentCaddyAdminTransport, setCaddyAdminTransport } from '../../src/lib/caddy-admin';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { chainFingerprint, checkCertificatePair } from '../../src/lib/certificate-pem';
import { buildDesiredState } from '../../src/lib/agent/desired-state';
import { resetCaddyMonitor } from '../../src/lib/caddy-monitor';
import { getCertificate, updateCertificate } from '../../src/lib/models/certificates';
import {
  createCertificateFromAgentFiles,
  ingestCertificateFileResults,
  rereadCertificateFile,
} from '../../src/lib/models/certificate-files';
import { deleteAgent } from '../../src/lib/models/agents';
import {
  assertProxyHostOptionsStorable,
  createProxyHost,
  updateProxyHost,
} from '../../src/lib/models/proxy-hosts';
import { runCertificateExpiryAlerts } from '../../src/lib/email/certificate-alerts';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../src/lib/email/transport';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';
import { encryptSecret } from '../../src/lib/secret';
import { clearAgentEnv, startFakeAgent, type FakeAgent } from '../helpers/fake-agent';
import { createSelfSignedServerCertificate, type GeneratedCertificate } from '../helpers/certs';

let first: GeneratedCertificate;
let renewed: GeneratedCertificate;
let other: GeneratedCertificate;

/** What each fake agent's files hold, by path. */
let files: Record<string, string>;

function answerReads(command: AgentCommand) {
  if (command.kind === 'certificate-files-list') return { status: 200, text: '[]' };
  if (command.kind !== 'certificate-files-read') return undefined;
  const results: CertificateFileResult[] = command.request.files.map((file) => {
    const certificatePem = files[file.certPath];
    const keyPem = files[file.keyPath];
    if (certificatePem === undefined || keyPem === undefined) {
      return { id: file.id, ok: false, error: 'not-found' };
    }
    return {
      id: file.id,
      ok: true,
      fingerprint: chainFingerprint(certificatePem.trim()),
      certificatePem,
      keyPem,
    };
  });
  return { status: 200, text: JSON.stringify(results) };
}

async function agentWithFiles(agentRowId: number): Promise<FakeAgent> {
  return startFakeAgent(
    { caddyAdmin: { status: 200, text: '{}' } },
    { agentRowId, capabilities: ['certificate-files'], answer: answerReads },
  );
}

function loadsOn(agent: FakeAgent): string[] {
  return agent.requests
    .flatMap((entry) =>
      entry.kind === 'command' && entry.command?.kind === 'caddy-admin'
        ? [entry.command.request]
        : [],
    )
    .filter((request) => request.path === '/load')
    .map((request) => request.body ?? '');
}

function full(id: number, pair: GeneratedCertificate): CertificateFileResult {
  const checked = checkCertificatePair(pair.certificatePem, pair.privateKeyPem);
  if (!checked.ok) throw new Error(checked.error);
  return {
    id,
    ok: true,
    fingerprint: checked.fingerprint,
    certificatePem: checked.certificatePem,
    keyPem: checked.keyPem,
  };
}

const now = () => new Date().toISOString();

beforeAll(() => {
  first = createSelfSignedServerCertificate('files.example.com', ['files.example.com'], 5);
  renewed = createSelfSignedServerCertificate(
    'files.example.com',
    ['files.example.com', 'www.files.example.com'],
    90,
  );
  other = createSelfSignedServerCertificate('other.example.com', ['other.example.com'], 90);
});

beforeEach(async () => {
  setCaddyAdminTransport(agentCaddyAdminTransport);
  resetCaddyMonitor();
  files = {
    'live/files/fullchain.pem': first.certificatePem,
    'live/files/privkey.pem': first.privateKeyPem,
    'live/other/privkey.pem': other.privateKeyPem,
  };
  await ctx.db.delete(schema.proxyHostAgents);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.certificates);
  await ctx.db.delete(schema.auditEvents);
  await ctx.db.delete(schema.agents);
  await ctx.db
    .insert(schema.users)
    .values({
      id: 1,
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      createdAt: now(),
      updatedAt: now(),
    })
    .onConflictDoNothing();
  for (const id of [1, 2]) {
    await ctx.db.insert(schema.agents).values({
      id,
      name: `edge-${id}`,
      agentId: `${id}`.repeat(32),
      secret: encryptSecret('secret'),
      createdAt: now(),
      updatedAt: now(),
    });
  }
});

afterEach(() => {
  clearAgentEnv();
  resetCaddyMonitor();
});

async function createFileCertificate(): Promise<number> {
  const cert = await createCertificateFromAgentFiles(
    {
      name: '',
      agentRowId: 1,
      certPath: 'live/files/fullchain.pem',
      keyPath: 'live/files/privkey.pem',
    },
    1,
  );
  return cert.id;
}

async function row(id: number) {
  const [found] = await ctx.db
    .select()
    .from(schema.certificates)
    .where(eq(schema.certificates.id, id));
  return found;
}

describe('adding a certificate from files', () => {
  it('reads it once, takes the names from its SANs and stores the key encrypted', async () => {
    const agent = await agentWithFiles(1);
    const id = await createFileCertificate();

    const cert = await getCertificate(id);
    expect(cert).toMatchObject({
      type: 'imported',
      source: 'agent-file',
      sourceAgentId: 1,
      sourceCertPath: 'live/files/fullchain.pem',
      domainNames: ['files.example.com'],
      sourceError: null,
    });
    expect(cert?.sourceReadAt).not.toBeNull();
    expect(cert?.privateKeyPem?.trim()).toBe(first.privateKeyPem.trim());
    expect((await row(id)).privateKeyPem).not.toContain('PRIVATE KEY');

    // The agent is told to keep reading it.
    expect(agent.desired?.certificateFiles).toEqual([
      { id, certPath: 'live/files/fullchain.pem', keyPath: 'live/files/privkey.pem' },
    ]);
  });

  it('refuses a key that is not the certificate s, and stores nothing', async () => {
    await agentWithFiles(1);
    files['live/files/privkey.pem'] = other.privateKeyPem;
    await expect(createFileCertificate()).rejects.toMatchObject({
      code: 'certificateFileKeyMismatch',
    });
    expect(await ctx.db.select().from(schema.certificates)).toHaveLength(0);
  });

  it('refuses a traversal before asking the agent anything', async () => {
    const agent = await agentWithFiles(1);
    await expect(
      createCertificateFromAgentFiles(
        {
          name: 'x',
          agentRowId: 1,
          certPath: '../../etc/shadow',
          keyPath: 'live/files/privkey.pem',
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'certificateFileInvalidPath' });
    expect(agent.requests.some((entry) => entry.kind === 'command')).toBe(false);
  });

  it('never asks an agent that has not listed the capability', async () => {
    const agent = await startFakeAgent({}, { agentRowId: 1, answer: answerReads });
    await expect(createFileCertificate()).rejects.toMatchObject({
      code: 'certificateFileAgentUnavailable',
    });
    expect(agent.requests.some((entry) => entry.kind === 'command')).toBe(false);
    expect(agent.desired?.certificateFiles).toBeUndefined();
    expect((await buildDesiredState(1)).certificateFiles).toBeUndefined();
  });
});

describe('what an agent sends back', () => {
  it('cannot write a certificate another agent is the source of', async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    const before = await row(id);

    const outcome = await ingestCertificateFileResults(2, [full(id, other)]);
    expect(outcome.refused).toEqual([id]);
    expect(await row(id)).toEqual(before);
  });

  it('cannot write an uploaded certificate', async () => {
    const [upload] = await ctx.db
      .insert(schema.certificates)
      .values({
        name: 'upload',
        type: 'imported',
        domainNames: JSON.stringify(['other.example.com']),
        certificatePem: other.certificatePem,
        privateKeyPem: encryptSecret(other.privateKeyPem),
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    const outcome = await ingestCertificateFileResults(1, [full(upload.id, first)]);
    expect(outcome.refused).toEqual([upload.id]);
    expect((await row(upload.id)).certificatePem).toBe(other.certificatePem);
  });

  it('is a no-op, with no reload, when the chain is unchanged', async () => {
    const agent = await agentWithFiles(1);
    const id = await createFileCertificate();
    const loads = loadsOn(agent).length;
    const before = await row(id);

    await ingestCertificateFileResults(1, [full(id, first)]);
    await ingestCertificateFileResults(1, [
      { id, ok: true, fingerprint: chainFingerprint(before.certificatePem ?? '') },
    ]);

    const after = await row(id);
    expect(after.certificatePem).toBe(before.certificatePem);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(loadsOn(agent)).toHaveLength(loads);
  });

  it('asks for the PEM again when a bare fingerprint is not the stored one', async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    const outcome = await ingestCertificateFileResults(1, [
      { id, ok: true, fingerprint: 'f'.repeat(64) },
    ]);
    expect(outcome.resend).toEqual([id]);
  });

  it('stores a renewal, re-derives and audits the names, and reloads only that agent', async () => {
    const source = await agentWithFiles(1);
    const bystander = await agentWithFiles(2);
    const id = await createFileCertificate();
    const sourceLoads = loadsOn(source).length;
    const bystanderLoads = loadsOn(bystander).length;

    await ingestCertificateFileResults(1, [full(id, renewed)]);

    const cert = await getCertificate(id);
    expect(cert?.domainNames).toEqual(['files.example.com', 'www.files.example.com']);
    expect(cert?.privateKeyPem?.trim()).toBe(renewed.privateKeyPem.trim());
    expect(loadsOn(source).length).toBe(sourceLoads + 1);
    expect(loadsOn(bystander).length).toBe(bystanderLoads);

    // Audit rows are mocked suite-wide (tests/setup.bun.ts), so the call is what is checked.
    const call = vi
      .mocked(logAuditEvent)
      .mock.calls.map(([event]) => event)
      .find((event) => event.action === 'certificate_file_names_changed');
    expect(call).toMatchObject({
      entityId: id,
      summary: 'Read a new version of certificate files.example.com with different names',
      data: { from: ['files.example.com'], to: ['files.example.com', 'www.files.example.com'] },
    });
  });

  it('keeps the last good certificate when a read fails, and says why', async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    const before = await row(id);

    const good = full(id, first);
    if (!good.ok) throw new Error('unreachable');
    await ingestCertificateFileResults(1, [{ ...good, keyPem: other.privateKeyPem }]);
    expect(await row(id)).toMatchObject({
      certificatePem: before.certificatePem,
      sourceError: 'key-mismatch',
    });

    await ingestCertificateFileResults(1, [{ id, ok: false, error: 'not-found' }]);
    expect((await row(id)).sourceError).toBe('not-found');

    // A good read clears it.
    await ingestCertificateFileResults(1, [full(id, first)]);
    expect((await row(id)).sourceError).toBeNull();
  });
});

describe('where it may be served', () => {
  it("goes into its own agent's document and no other", async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    await createProxyHost(
      {
        name: 'files',
        domains: ['files.example.com'],
        upstreams: ['backend:8080'],
        certificateId: id,
        agentIds: [1],
      } as never,
      1,
    );
    // Forge writes CRLF; one base64 line of the body is enough to recognise it.
    const pem = first.certificatePem.trim().split(/\r?\n/)[1] ?? '';

    expect(JSON.stringify(await buildCaddyDocument(1))).toContain(pem);
    expect(JSON.stringify(await buildCaddyDocument(2))).not.toContain(pem);
  });

  it('stays out of the unscoped document the direct transport loads, host and all', async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    await createProxyHost(
      {
        name: 'files',
        domains: ['files.example.com'],
        upstreams: ['backend:8080'],
        certificateId: id,
        agentIds: [1],
      } as never,
      1,
    );
    const pem = first.certificatePem.trim().split(/\r?\n/)[1] ?? '';

    // Left out rather than handed to ACME, as on an agent it is not pinned to.
    const direct = JSON.stringify(await buildCaddyDocument());
    expect(direct).not.toContain(pem);
    expect(direct).not.toContain('files.example.com');
    // A diff that is never loaded still shows the whole fleet.
    const preview = JSON.stringify(
      await buildCaddyDocument(undefined, { includeAgentFileCertificates: true }),
    );
    expect(preview).toContain('files.example.com');
  });

  it('may only be used by a host pinned to that agent alone', async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    const host = (agentIds: number[]) =>
      ({
        name: 'files',
        domains: ['files.example.com'],
        upstreams: ['backend:8080'],
        certificateId: id,
        agentIds,
      }) as never;

    for (const agentIds of [[], [2], [1, 2]]) {
      await expect(createProxyHost(host(agentIds), 1)).rejects.toMatchObject({
        code: 'certificateFileAgentOnly',
      });
    }
    const created = await createProxyHost(host([1]), 1);
    // Moving the host off the agent is refused too.
    await expect(updateProxyHost(created.id, { agentIds: [] }, 1)).rejects.toMatchObject({
      code: 'certificateFileAgentOnly',
    });
    await expect(
      assertProxyHostOptionsStorable({
        domains: ['files.example.com'],
        certificateId: id,
        agentIds: [],
        meta: null,
        customCaddyfileChanged: false,
      }),
    ).rejects.toMatchObject({ code: 'certificateFileAgentOnly' });
  });

  it('keeps its PEM and names out of hand edits', async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    await expect(
      updateCertificate(id, { domainNames: ['evil.example.com'] }, 1),
    ).rejects.toMatchObject({ code: 'certificateFileFieldsReadOnly' });
    await expect(
      updateCertificate(id, { certificatePem: other.certificatePem }, 1),
    ).rejects.toMatchObject({ code: 'certificateFileFieldsReadOnly' });
    expect((await updateCertificate(id, { name: 'Renamed' }, 1)).name).toBe('Renamed');
  });
});

describe('after its agent is deleted', () => {
  it('keeps the last PEM, serves it on no other agent, and leaves the host dark rather than on ACME', async () => {
    await agentWithFiles(1);
    const id = await createFileCertificate();
    const host = await createProxyHost(
      {
        name: 'files',
        domains: ['files.example.com'],
        upstreams: ['backend:8080'],
        certificateId: id,
        agentIds: [1],
      } as never,
      1,
    );
    clearAgentEnv();

    await deleteAgent(1);

    const orphan = await row(id);
    expect(orphan.sourceAgentId).toBeNull();
    expect(orphan.certificatePem).toBe(first.certificatePem.trim());
    // The pin cascades away, which would otherwise make the host every agent's.
    expect(
      await ctx.db
        .select()
        .from(schema.proxyHostAgents)
        .where(eq(schema.proxyHostAgents.proxyHostId, host.id)),
    ).toHaveLength(0);
    const pem = first.certificatePem.trim().split(/\r?\n/)[1] ?? '';
    const survivor = JSON.stringify(await buildCaddyDocument(2));
    expect(survivor).not.toContain(pem);
    expect(survivor).not.toContain('files.example.com');
    await expect(rereadCertificateFile(id, 1)).rejects.toMatchObject({
      code: 'certificateFileAgentUnavailable',
    });
    // Nor can it be moved to another agent to bring it back.
    await expect(updateProxyHost(host.id, { agentIds: [2] }, 1)).rejects.toMatchObject({
      code: 'certificateFileAgentOnly',
    });
  });
});

describe('expiry alerts', () => {
  let sent: OutgoingEmail[] = [];

  beforeEach(() => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'proxy@example.com';
    invalidateSettingsCache();
    sent = [];
    setEmailDeliveryForTests(async (_config, message) => {
      sent.push(message);
    });
  });

  afterAll(() => {
    setEmailDeliveryForTests(null);
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
  });

  it('picks up a file certificate like any imported one', async () => {
    await ctx.db.delete(schema.users);
    await ctx.db.insert(schema.users).values({
      id: 1,
      email: 'ops@example.com',
      name: 'Ops',
      role: 'admin',
      createdAt: now(),
      updatedAt: now(),
    });
    await agentWithFiles(1);
    await createCertificateFromAgentFiles(
      {
        name: 'From files',
        agentRowId: 1,
        certPath: 'live/files/fullchain.pem',
        keyPath: 'live/files/privkey.pem',
      },
      1,
    );
    expect(await runCertificateExpiryAlerts()).toEqual({ sent: 1 });
    expect(sent[0]?.text).toContain('From files (imported) expires on');
  });
});
