/**
 * The dashboard's config export and import: every private key leaves in the file and an import
 * writes groups and grants, so both want a fresh sign-in, as a backup restore does. The dry run
 * does not.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { NextRequest } from 'next/server';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '../../helpers/next-intl';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as { id: number; createdAt: Date } | null,
}));

const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());

// Only the session and its age vary; the freshness rule stays real.
const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  checkSameOrigin: () => null,
  requireAdmin: async () => ({ user: { id: '1', email: 'a@example.com', role: 'admin' } }),
  getCurrentSessionInfo: async () => ctx.session,
}));

const { POST: exportRoute } = await import('@/src/app/api/config/export/route');
const { POST: importRoute } = await import('@/src/app/api/config/import/route');
const { exportConfig } = await import('@/src/lib/config-transfer');
const schema = await import('@/src/lib/db/schema');

const PASSPHRASE = 'correct horse battery staple';
const MINUTE = 60_000;

function exportRequest() {
  return new NextRequest('http://localhost:3000/api/config/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: PASSPHRASE, sections: ['security'] }),
  });
}

function importRequest(file: Buffer, step: string) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(file)]), 'cpm-config.json');
  form.set('step', step);
  form.set('passphrase', PASSPHRASE);
  return new NextRequest('http://localhost:3000/api/config/import', { method: 'POST', body: form });
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'a@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'a',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db
    .insert(schema.blockedSources)
    .values({ kind: 'country', value: 'KP', createdAt: now });
});

describe('config export and import need a fresh sign-in', () => {
  it('refuses an export from an old session and allows it from a fresh one', async () => {
    ctx.session = { id: 1, createdAt: new Date(Date.now() - 60 * MINUTE) };
    const stale = await exportRoute(exportRequest());
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code?: string }).code).toBe('reauth-required');

    ctx.session = { id: 1, createdAt: new Date(Date.now() - MINUTE) };
    expect((await exportRoute(exportRequest())).status).toBe(200);
  });

  it('previews from an old session but applies only from a fresh one', async () => {
    const file = await exportConfig(PASSPHRASE, { sections: ['security'] });
    await ctx.db.delete(schema.blockedSources);
    ctx.session = { id: 1, createdAt: new Date(Date.now() - 60 * MINUTE) };
    expect((await importRoute(importRequest(file, 'preview'))).status).toBe(200);
    const stale = await importRoute(importRequest(file, 'apply'));
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code?: string }).code).toBe('reauth-required');
    expect(await ctx.db.select().from(schema.blockedSources)).toEqual([]);

    ctx.session = { id: 1, createdAt: new Date() };
    expect((await importRoute(importRequest(file, 'apply'))).status).toBe(200);
    expect(await ctx.db.select().from(schema.blockedSources)).toHaveLength(1);
  });
});
