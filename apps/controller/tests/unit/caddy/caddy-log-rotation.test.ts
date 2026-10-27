/**
 * Regression: Caddy's rotation defaults stopped compressing and pruning rolled logs, filling the
 * disk (11GB+), so roll settings are spelled out.
 */
import { describe, it, expect } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { buildCaddyDocument } from '../../../src/lib/caddy';
import * as schema from '../../../src/lib/db/schema';
import { saveLoggingSettings } from '../../../src/lib/settings';

const ROLL_FIELDS = {
  roll: true,
  roll_size_mb: 100,
  roll_gzip: true,
  roll_keep: 10,
  roll_keep_days: 30,
};

function loggingLogs(doc: unknown): Record<string, { writer?: Record<string, unknown> }> {
  return (
    (doc as { logging?: { logs?: Record<string, { writer?: Record<string, unknown> }> } })?.logging
      ?.logs ?? {}
  );
}

describe('Caddy log writer rotation settings', () => {
  it('waf_rules writer always carries explicit roll settings (unconditional logger)', async () => {
    const doc = await buildCaddyDocument();
    const writer = loggingLogs(doc).waf_rules?.writer;
    expect(writer).toMatchObject(ROLL_FIELDS);
  });

  it('http_access writer carries explicit roll settings when access logging is enabled', async () => {
    await saveLoggingSettings({ enabled: true, format: 'json' });
    const doc = await buildCaddyDocument();
    const writer = loggingLogs(doc).http_access?.writer;
    expect(writer).toMatchObject(ROLL_FIELDS);
  });

  it('logs L4 connections only when asked, and only with an L4 host to log', async () => {
    await saveLoggingSettings({ enabled: false, l4Connections: true });
    expect(loggingLogs(await buildCaddyDocument()).l4_connections).toBeUndefined();

    const now = new Date().toISOString();
    await ctx.db.insert(schema.l4ProxyHosts).values({
      name: 'db',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: JSON.stringify(['db:5432']),
      matcherType: 'none',
      matcherValue: null,
      tlsTermination: false,
      proxyProtocolVersion: null,
      proxyProtocolReceive: false,
      meta: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(loggingLogs(await buildCaddyDocument()).l4_connections).toMatchObject({
      writer: { filename: '/logs/l4-connections.log', ...ROLL_FIELDS },
      include: ['layer4'],
      exclude: ['layer4.handlers', 'layer4.matchers'],
      level: 'DEBUG',
    });

    await saveLoggingSettings({ enabled: false });
    expect(loggingLogs(await buildCaddyDocument()).l4_connections).toBeUndefined();
    await ctx.db.delete(schema.l4ProxyHosts);
  });

  it('does not omit any roll field (would silently fall back to Caddy defaults)', async () => {
    const doc = await buildCaddyDocument();
    const writer = loggingLogs(doc).waf_rules?.writer as Record<string, unknown>;
    for (const field of Object.keys(ROLL_FIELDS)) {
      expect(writer[field], `writer.${field} must be explicitly set`).toBeDefined();
    }
  });
});
