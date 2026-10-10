/**
 * Body limits Coraza would refuse are rejected at write time (#252): at load time Caddy rejects
 * the whole document, not just this host.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// Bun mock factories run synchronously, so their helpers are imported up here.
const { createTestDb } = await import('../../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import {
  createProxyHost,
  updateProxyHost,
  getProxyHost,
  type ProxyHostInput,
  type WafHostConfig,
} from '../../../src/lib/models/proxy-hosts';
import * as schema from '../../../src/lib/db/schema';
import { setSetting } from '../../../src/lib/settings';

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin',
    provider: 'credentials',
    subject: 'test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

function hostInput(waf: WafHostConfig, name = 'waf-host'): ProxyHostInput {
  return {
    name,
    domains: [`${name}.example.com`],
    upstreams: ['10.0.0.5:8080'],
    waf,
  };
}

const validWaf: WafHostConfig = { enabled: true, waf_mode: 'merge' };

describe('per-host WAF body limits', () => {
  it('persists limits inside Coraza’s range', async () => {
    const host = await createProxyHost(
      hostInput({
        ...validWaf,
        request_body_limit: 536870912,
        request_body_limit_action: 'ProcessPartial',
      }),
      1,
    );

    const fetched = await getProxyHost(host.id);
    expect(fetched?.waf?.request_body_limit).toBe(536870912);
    expect(fetched?.waf?.request_body_limit_action).toBe('ProcessPartial');
  });

  it('rejects a limit above the 1 GiB Coraza accepts', async () => {
    await expect(
      createProxyHost(hostInput({ ...validWaf, request_body_limit: 10737418240 }, 'too-big'), 1),
    ).rejects.toThrow(/waf\.request_body_limit must be an integer between/);
  });

  it('rejects an in-memory limit larger than the request limit', async () => {
    await expect(
      createProxyHost(
        hostInput(
          { ...validWaf, request_body_limit: 1048576, request_body_in_memory_limit: 2097152 },
          'inverted',
        ),
        1,
      ),
    ).rejects.toThrow(/must not exceed/);
  });

  it('rejects an out-of-range limit smuggled through custom directives', async () => {
    await expect(
      createProxyHost(
        hostInput(
          { ...validWaf, custom_directives: 'SecRequestBodyLimit 10737418240' },
          'smuggled',
        ),
        1,
      ),
    ).rejects.toThrow(/out-of-range body limit/);
  });

  it('refuses a custom directive the allowlist would silently drop', async () => {
    // Only the strict global setting drops an engine directive.
    await setSetting('waf', {
      enabled: true,
      mode: 'On',
      load_owasp_crs: false,
      custom_directives: '',
      strict_directives: true,
    });
    await expect(
      createProxyHost(
        hostInput(
          { ...validWaf, custom_directives: 'SecRuleUpdateActionById 9001 "deny"' },
          'dropped-directive',
        ),
        1,
      ),
    ).rejects.toThrow(/would be dropped and never sent to Caddy/);
  });

  it('rejects an unknown over-limit action', async () => {
    await expect(
      createProxyHost(
        hostInput({ ...validWaf, request_body_limit_action: 'Drop' as never }, 'bad-action'),
        1,
      ),
    ).rejects.toThrow(/Reject or ProcessPartial/);
  });

  it('rejects a bad limit on update and leaves the stored value intact', async () => {
    const host = await createProxyHost(
      hostInput({ ...validWaf, request_body_limit: 536870912 }, 'updated'),
      1,
    );

    await expect(
      updateProxyHost(host.id, { waf: { ...validWaf, request_body_limit: 10737418240 } }, 1),
    ).rejects.toThrow(/waf\.request_body_limit must be an integer between/);

    const fetched = await getProxyHost(host.id);
    expect(fetched?.waf?.request_body_limit).toBe(536870912);
  });
});
