/**
 * Per-host WAF directives are checked when written, not on every later update: a stored rule a
 * newer release drops must not fail the enable toggle, a rule suppression or a PATCH of other
 * fields, while a line an update newly drops is still refused.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import {
  createProxyHost,
  getProxyHost,
  updateProxyHost,
  type WafHostConfig,
} from '../../../src/lib/models/proxy-hosts';
import { setSetting } from '../../../src/lib/settings';
import * as schema from '../../../src/lib/db/schema';

const LEGACY_RULE =
  'SecRule REMOTE_ADDR "@ipMatchFromFile /etc/caddy/blocklist.txt" "id:9001,phase:1,deny,status:403"';

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  // The legacy rule reads a file, which only the strict setting refuses.
  await setSetting('waf', {
    enabled: true,
    mode: 'On',
    load_owasp_crs: false,
    custom_directives: '',
    strict_directives: true,
  });
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

/** A host whose stored WAF config holds a rule the validators now refuse. */
async function hostWithLegacyRule(): Promise<{ id: number; waf: WafHostConfig }> {
  const waf: WafHostConfig = {
    enabled: true,
    waf_mode: 'override',
    mode: 'On',
    custom_directives: '',
  };
  const host = await createProxyHost(
    { name: 'legacy', domains: ['legacy.example.com'], upstreams: ['10.0.0.5:8080'], waf },
    1,
  );
  const stored: WafHostConfig = { ...waf, custom_directives: LEGACY_RULE };
  const row = await ctx.db.query.proxyHosts.findFirst({ where: (t, { eq }) => eq(t.id, host.id) });
  const meta = JSON.parse(row?.meta ?? '{}');
  await ctx.db
    .update(schema.proxyHosts)
    .set({ meta: JSON.stringify({ ...meta, waf: stored }) })
    .where(eq(schema.proxyHosts.id, host.id));
  return { id: host.id, waf: stored };
}

describe('stored WAF custom directives on update', () => {
  it('still refuses the rule on a new host', async () => {
    await expect(
      createProxyHost(
        {
          name: 'new',
          domains: ['new.example.com'],
          upstreams: ['10.0.0.5:8080'],
          waf: { enabled: true, waf_mode: 'override', custom_directives: LEGACY_RULE },
        },
        1,
      ),
    ).rejects.toThrow(/ipMatchFromFile reads files/);
  });

  it('lets the host be toggled and renamed without touching the WAF', async () => {
    const host = await hostWithLegacyRule();

    await updateProxyHost(host.id, { enabled: false }, 1);
    await updateProxyHost(host.id, { name: 'renamed' }, 1);

    const fetched = await getProxyHost(host.id);
    expect(fetched?.enabled).toBe(false);
    expect(fetched?.name).toBe('renamed');
    expect(fetched?.waf?.custom_directives).toBe(LEGACY_RULE);
  });

  it('accepts a WAF update that leaves the directives as stored', async () => {
    const host = await hostWithLegacyRule();

    await updateProxyHost(host.id, { waf: { ...host.waf, excluded_rule_ids: [941100] } }, 1);

    const fetched = await getProxyHost(host.id);
    expect(fetched?.waf?.excluded_rule_ids).toEqual([941100]);
    expect(fetched?.waf?.custom_directives).toBe(LEGACY_RULE);
  });

  it('accepts new rules beside the stored dropped line, but refuses a newly dropped one', async () => {
    const host = await hostWithLegacyRule();
    const withKeptRule = `${LEGACY_RULE}\nSecRule ARGS "@contains x" "id:9002,deny"`;

    await updateProxyHost(host.id, { waf: { ...host.waf, custom_directives: withKeptRule } }, 1);
    expect((await getProxyHost(host.id))?.waf?.custom_directives).toBe(withKeptRule);

    const added = 'SecRule ARGS "@pmFromFile /etc/hosts" "id:9004,deny"';
    const update = updateProxyHost(
      host.id,
      { waf: { ...host.waf, custom_directives: `${withKeptRule}\n${added}` } },
      1,
    );
    await expect(update).rejects.toThrow(/pmFromFile reads files/);
    await expect(update).rejects.toThrow(/has 1 line\(s\)/);
    expect((await getProxyHost(host.id))?.waf?.custom_directives).toBe(withKeptRule);
  });

  it('refuses turning the CRS off under an unchanged rule that reads a CRS data file', async () => {
    const rule = 'SecRule ARGS "@pmf @owasp_crs/unix-shell.data" "id:9005,deny"';
    const waf: WafHostConfig = {
      enabled: true,
      waf_mode: 'override',
      load_owasp_crs: true,
      custom_directives: rule,
    };
    const host = await createProxyHost(
      { name: 'crs', domains: ['crs.example.com'], upstreams: ['10.0.0.5:8080'], waf },
      1,
    );

    await expect(
      updateProxyHost(host.id, { waf: { ...waf, load_owasp_crs: false } }, 1),
    ).rejects.toThrow(/OWASP CRS is loaded/);
    await expect(
      updateProxyHost(host.id, { waf: { ...waf, waf_mode: 'merge', load_owasp_crs: false } }, 1),
    ).rejects.toThrow(/OWASP CRS is loaded/);
    expect((await getProxyHost(host.id))?.waf?.load_owasp_crs).toBe(true);
  });

  it('refuses a merge-mode rule reusing a global rule id, but not in override mode', async () => {
    await setSetting('waf', {
      enabled: true,
      mode: 'On',
      load_owasp_crs: false,
      custom_directives: 'SecRule REQUEST_URI "@beginsWith /global/" "id:9100,phase:1,pass,nolog"',
    });
    const hostRule = 'SecRule REQUEST_URI "@beginsWith /host/" "id:9100,phase:1,deny,status:403"';
    const input = (waf_mode: 'merge' | 'override') => ({
      name: `dup-${waf_mode}`,
      domains: [`dup-${waf_mode}.example.com`],
      upstreams: ['10.0.0.5:8080'],
      waf: { enabled: true, waf_mode, mode: 'On' as const, custom_directives: hostRule },
    });

    await expect(createProxyHost(input('merge'), 1)).rejects.toThrow(/9100/);
    const host = await createProxyHost(input('override'), 1);
    expect((await getProxyHost(host.id))?.waf?.custom_directives).toBe(hostRule);
  });
});
