/**
 * SECURITY-AUDIT H2: raw Caddyfile/JSON fields can author any handler, so only an admin may change
 * them - though an operator can still save a host whose snippet an admin wrote.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    },
  };
});

vi.mock('../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import { createProxyHost, updateProxyHost, getProxyHost } from '../../src/lib/models/proxy-hosts';
import { DomainError } from '../../src/lib/domain-error';
import * as schema from '../../src/lib/db/schema';

const ADMIN = 1;
const OPERATOR = 2;
const PRE_HANDLERS = '[{"handler":"file_server","root":"/"}]';
const REVERSE_PROXY = '{"upstreams":[{"dial":"caddy:2019"}]}';

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  const now = new Date().toISOString();
  for (const [id, role] of [
    [ADMIN, 'admin'],
    [OPERATOR, 'operator'],
  ] as const) {
    await ctx.db.insert(schema.users).values({
      id,
      email: `${role}@example.com`,
      name: role,
      role,
      provider: 'credentials',
      subject: role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }
});

async function hostWithSnippet() {
  return createProxyHost(
    {
      name: 'raw',
      domains: ['raw.example.com'],
      upstreams: ['10.0.0.5:8080'],
      customPreHandlersJson: PRE_HANDLERS,
    },
    ADMIN,
  );
}

async function expectAdminOnly(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(DomainError);
  await expect(promise).rejects.toMatchObject({ code: 'rawCaddyConfigAdminOnly' });
}

describe('raw Caddy config is admin-only', () => {
  it('rejects an operator setting any of the three raw fields', async () => {
    const host = await createProxyHost(
      { name: 'plain', domains: ['plain.example.com'], upstreams: ['10.0.0.5:8080'] },
      ADMIN,
    );

    await expectAdminOnly(
      updateProxyHost(host.id, { customPreHandlersJson: PRE_HANDLERS }, OPERATOR),
    );
    await expectAdminOnly(
      updateProxyHost(host.id, { customReverseProxyJson: REVERSE_PROXY }, OPERATOR),
    );
    // Refused before Caddy is asked to adapt it.
    await expectAdminOnly(updateProxyHost(host.id, { customCaddyfile: 'respond "x"' }, OPERATOR));

    const stored = await getProxyHost(host.id);
    expect(stored?.customPreHandlersJson).toBeNull();
    expect(stored?.customReverseProxyJson).toBeNull();
    expect(stored?.customCaddyfile).toBeNull();
  });

  it("rejects an operator changing or clearing an admin's snippet", async () => {
    const host = await hostWithSnippet();

    await expectAdminOnly(updateProxyHost(host.id, { customPreHandlersJson: '[]' }, OPERATOR));
    await expectAdminOnly(updateProxyHost(host.id, { customPreHandlersJson: null }, OPERATOR));
    await expectAdminOnly(updateProxyHost(host.id, { customPreHandlersJson: '' }, OPERATOR));

    expect((await getProxyHost(host.id))?.customPreHandlersJson).toBe(PRE_HANDLERS);
  });

  it('lets an operator resubmit the stored value or omit the field while editing the host', async () => {
    const host = await hostWithSnippet();

    await updateProxyHost(
      host.id,
      { name: 'renamed', customPreHandlersJson: `  ${PRE_HANDLERS}\n`, customCaddyfile: '' },
      OPERATOR,
    );
    await updateProxyHost(host.id, { upstreams: ['10.0.0.6:8080'] }, OPERATOR);

    const stored = await getProxyHost(host.id);
    expect(stored?.name).toBe('renamed');
    expect(stored?.upstreams).toEqual(['10.0.0.6:8080']);
    expect(stored?.customPreHandlersJson).toBe(PRE_HANDLERS);
  });

  it('lets an admin change the raw fields', async () => {
    const host = await hostWithSnippet();
    await updateProxyHost(host.id, { customReverseProxyJson: REVERSE_PROXY }, ADMIN);
    expect((await getProxyHost(host.id))?.customReverseProxyJson).toBe(REVERSE_PROXY);
  });

  it('fails closed for an actor that is not a user', async () => {
    const host = await hostWithSnippet();
    await expectAdminOnly(updateProxyHost(host.id, { customPreHandlersJson: '[]' }, 9999));
  });

  it('rejects a create carrying raw config from a non-admin', async () => {
    await expectAdminOnly(
      createProxyHost(
        {
          name: 'op-create',
          domains: ['op.example.com'],
          upstreams: ['10.0.0.5:8080'],
          customReverseProxyJson: REVERSE_PROXY,
        },
        OPERATOR,
      ),
    );
  });
});

describe('upstreams that reach the Caddy admin API are admin-only', () => {
  async function expectUpstreamAdminOnly(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({ code: 'upstreamTargetAdminOnly' });
  }

  it.each([
    'caddy:2019',
    'http://localhost:2019',
    '[::1]:2019',
    'tcp/caddy:2019',
    'caddy:2000-2100',
    'unix//run/caddy/admin.sock',
    'caddy:{http.request.uri.query.p}',
  ])('refuses an operator adding %s', async (target) => {
    const host = await createProxyHost(
      { name: 'plain', domains: ['plain.example.com'], upstreams: ['10.0.0.5:8080'] },
      ADMIN,
    );
    await expectUpstreamAdminOnly(updateProxyHost(host.id, { upstreams: [target] }, OPERATOR));
    expect((await getProxyHost(host.id))?.upstreams).toEqual(['10.0.0.5:8080']);
  });

  it('refuses an operator creating a host or an outpost upstream on the admin port', async () => {
    await expectUpstreamAdminOnly(
      createProxyHost(
        { name: 'op', domains: ['op.example.com'], upstreams: ['caddy:2019'] },
        OPERATOR,
      ),
    );
    const host = await createProxyHost(
      { name: 'plain', domains: ['plain.example.com'], upstreams: ['10.0.0.5:8080'] },
      ADMIN,
    );
    await expectUpstreamAdminOnly(
      updateProxyHost(host.id, { authentik: { outpostUpstream: 'caddy:2019' } }, OPERATOR),
    );
  });

  it('refuses an operator pointing Anubis at the admin port', async () => {
    const anubis = { enabled: true, upstream: 'http://caddy:2019', exemptPaths: [] };
    await expectUpstreamAdminOnly(
      createProxyHost(
        { name: 'op', domains: ['op.example.com'], upstreams: ['10.0.0.5:8080'], anubis },
        OPERATOR,
      ),
    );
    const host = await createProxyHost(
      { name: 'plain', domains: ['plain.example.com'], upstreams: ['10.0.0.5:8080'] },
      ADMIN,
    );
    await expectUpstreamAdminOnly(updateProxyHost(host.id, { anubis }, OPERATOR));
    expect((await getProxyHost(host.id))?.anubis).toBeNull();

    await updateProxyHost(host.id, { anubis }, ADMIN);
    await updateProxyHost(host.id, { name: 'renamed', anubis }, OPERATOR);
    await updateProxyHost(
      host.id,
      { anubis: { ...anubis, upstream: 'http://anubis:8923' } },
      OPERATOR,
    );
    expect((await getProxyHost(host.id))?.anubis?.upstream).toBe('http://anubis:8923');
  });

  it('lets an operator keep a target an admin set, and an admin set one', async () => {
    const host = await createProxyHost(
      { name: 'admin-set', domains: ['admin.example.com'], upstreams: ['caddy:2019'] },
      ADMIN,
    );
    await updateProxyHost(host.id, { name: 'renamed', upstreams: ['caddy:2019'] }, OPERATOR);
    await updateProxyHost(host.id, { upstreams: ['10.0.0.5:2020', 'app:8080'] }, OPERATOR);
    expect((await getProxyHost(host.id))?.upstreams).toEqual(['10.0.0.5:2020', 'app:8080']);
  });
});
