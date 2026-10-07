/**
 * Audit sinks as saved: what each kind requires, what is refused, and that an HTTP sink's URL and
 * auth header value stay encrypted and are never shown back.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { accessOf } from '@/tests/helpers/access';
import { capabilitiesOf } from '@/tests/helpers/access';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphql } from 'graphql';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('@/tests/helpers/db');
vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

const { createSink, deleteSink, listSinks, updateSink } = await import('@/src/lib/audit-stream');
const { auditEventRow, insertAuditRows } = await import('@/src/lib/audit');
const { pruneAuditEvents } = await import('@/src/lib/audit/chain');
const { auditSinks } = await import('@/src/lib/db/schema');
const { DomainError } = await import('@/src/lib/errors/domain-error');
const { schema: gqlSchema } = await import('@/src/lib/graphql/schema');

// A file sink's test record lands under the data volume.
const dataDir = mkdtempSync(join(tmpdir(), 'cpm-audit-sinks-'));
process.env.L4_PORTS_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(async () => {
  ctx.db = await createTestDb();
});

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('audit sinks', () => {
  it('fills in the defaults for each kind', async () => {
    const tls = await createSink({ name: 'tls', kind: 'syslog-tls', host: 'logs.example' }, null);
    expect(tls).toMatchObject({ port: 6514, target: 'logs.example:6514', maxBytes: null });
    const udp = await createSink({ name: 'udp', kind: 'syslog-udp', host: '10.0.0.5' }, null);
    expect(udp).toMatchObject({ port: 514, maxBytes: 2048 });
    const http = await createSink(
      { name: 'http', kind: 'http', url: 'https://siem.example/ingest' },
      null,
    );
    expect(http).toMatchObject({
      encoding: 'identity',
      headerName: 'Authorization',
      includeSecurity: false,
      enabled: true,
    });
  });

  it('refuses what cannot be sent to', async () => {
    const codes = await Promise.all([
      refusal(() => createSink({ name: '', kind: 'file', fileName: 'a.jsonl' }, null)),
      refusal(() => createSink({ name: 'x', kind: 'carrier-pigeon' }, null)),
      refusal(() => createSink({ name: 'x', kind: 'syslog-udp', host: 'bad host' }, null)),
      refusal(() => createSink({ name: 'x', kind: 'syslog-udp', host: '169.254.169.254' }, null)),
      refusal(() =>
        createSink({ name: 'x', kind: 'syslog-tcp', host: 'logs.example', port: 70_000 }, null),
      ),
      refusal(() =>
        createSink({ name: 'x', kind: 'syslog-udp', host: 'logs.example', maxBytes: 100 }, null),
      ),
      refusal(() =>
        createSink({ name: 'x', kind: 'syslog-tls', host: 'logs.example', ca: 'not a pem' }, null),
      ),
      refusal(() => createSink({ name: 'x', kind: 'http', url: 'http://siem.example/' }, null)),
      refusal(() =>
        createSink({ name: 'x', kind: 'http', url: 'https://u:p@siem.example/' }, null),
      ),
      refusal(() =>
        createSink({ name: 'x', kind: 'http', url: 'https://siem.example/', encoding: 'br' }, null),
      ),
      refusal(() =>
        createSink(
          { name: 'x', kind: 'http', url: 'https://siem.example/', headerName: 'Content-Type' },
          null,
        ),
      ),
      refusal(() => createSink({ name: 'x', kind: 'file', fileName: '../escape.jsonl' }, null)),
      refusal(() => createSink({ name: 'x', kind: 'file', fileName: 'a/b.jsonl' }, null)),
    ]);
    expect(codes).toEqual([
      'auditSinkNameRequired',
      'auditSinkKindInvalid',
      'auditSinkHostInvalid',
      'auditSinkMetadata',
      'auditSinkPortInvalid',
      'auditSinkMaxBytesInvalid',
      'auditSinkCaInvalid',
      'auditSinkUrlHttps',
      'auditSinkUrlInvalid',
      'auditSinkEncodingInvalid',
      'auditSinkHeaderInvalid',
      'auditSinkFileInvalid',
      'auditSinkFileInvalid',
    ]);
    await createSink({ name: 'taken', kind: 'file', fileName: 'a.jsonl' }, null);
    expect(
      await refusal(() => createSink({ name: 'taken', kind: 'file', fileName: 'b.jsonl' }, null)),
    ).toBe('auditSinkNameTaken');
  });

  it('keeps the URL and header value encrypted and never shows them', async () => {
    const sink = await createSink(
      {
        name: 'siem',
        kind: 'http',
        url: 'https://siem.example/hec?channel=secret-channel',
        headerName: 'Authorization',
        headerValue: 'Splunk 1234-secret',
      },
      null,
    );
    const [row] = await ctx.db.select().from(auditSinks);
    expect(row.secret.startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify(row)).not.toContain('1234-secret');
    expect(JSON.stringify(row)).not.toContain('secret-channel');
    const listed = JSON.stringify(await listSinks());
    expect(listed).not.toContain('1234-secret');
    expect(listed).not.toContain('secret-channel');
    expect(sink).toMatchObject({ target: 'https://siem.example/…', hasHeaderValue: true });

    // A blank URL and header keep both; a new origin needs the header again.
    const kept = await updateSink(sink.id, { name: 'siem', kind: 'http', encoding: 'gzip' }, null);
    expect(kept).toMatchObject({ hasHeaderValue: true, encoding: 'gzip' });
    expect(
      await refusal(() =>
        updateSink(
          sink.id,
          { name: 'siem', kind: 'http', url: 'https://elsewhere.example/' },
          null,
        ),
      ),
    ).toBe('auditSinkSecretReentry');
    const cleared = await updateSink(
      sink.id,
      { name: 'siem', kind: 'http', url: 'https://elsewhere.example/', clearHeaderValue: true },
      null,
    );
    expect(cleared.hasHeaderValue).toBe(false);
  });

  it('starts from the oldest event the log holds and reports how far behind it is', async () => {
    const event = () => insertAuditRows([auditEventRow({ action: 'update', entityType: 'thing' })]);
    for (let i = 0; i < 3; i++) await event();
    await pruneAuditEvents(new Date(Date.now() + 1000).toISOString());
    for (let i = 0; i < 2; i++) await event();
    const sink = await createSink({ name: 'new', kind: 'file', fileName: 'n.jsonl' }, null);
    expect(sink).toMatchObject({ auditCursor: 3, auditLag: 2, securityLag: null });
    await deleteSink(sink.id, null);
    expect(await listSinks()).toEqual([]);
  });
});

describe('audit sinks over GraphQL', () => {
  function as(role: string) {
    const contextValue = {
      viewer: async () => ({ userId: null, role, authMethod: 'bearer' as const }),
      access: async () => ({
        userId: null,
        role,
        capabilities: capabilitiesOf(role),
        grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
      }),
      rawBody: async () => '',
      request: {} as never,
    };
    return async (source: string, variableValues: Record<string, unknown> = {}) => {
      const answer = await graphql({ schema: gqlSchema, source, variableValues, contextValue });
      expect(answer.errors).toBeUndefined();
      return answer.data as Record<string, any>;
    };
  }
  const admin = as('admin');

  it('creates, tests, updates, lists and deletes a sink', async () => {
    const { createAuditSink: created } = await admin(
      'mutation ($input: AuditSinkInput!) { createAuditSink(input: $input) { id target } }',
      { input: { name: 'gql', kind: 'file', fileName: 'gql.jsonl' } },
    );
    expect(created.target).toBe('gql.jsonl');
    expect(
      await admin('mutation ($id: Int) { testAuditSink(id: $id) { encodingRefused } }', {
        id: created.id,
      }),
    ).toEqual({ testAuditSink: { encodingRefused: false } });
    await admin(
      'mutation ($id: Int!, $input: AuditSinkInput!) { updateAuditSink(id: $id, input: $input) { id } }',
      { id: created.id, input: { name: 'gql-renamed', kind: 'file', fileName: 'gql.jsonl' } },
    );
    expect(await admin('{ auditSinks { name } }')).toEqual({
      auditSinks: [{ name: 'gql-renamed' }],
    });
    expect(
      await admin('mutation ($id: Int!) { deleteAuditSink(id: $id) }', { id: created.id }),
    ).toEqual({ deleteAuditSink: true });
    expect(await listSinks()).toEqual([]);
  });

  it('refuses anyone but an administrator', async () => {
    const answer = await graphql({
      schema: gqlSchema,
      source: '{ auditSinks { id } }',
      contextValue: {
        viewer: async () => ({ userId: 2, role: 'user', authMethod: 'bearer' as const }),
        access: async () => accessOf('user', {}, 2),
      },
    });
    expect(answer.errors?.[0]?.message).toBe("This account's role does not allow this request");
  });
});
