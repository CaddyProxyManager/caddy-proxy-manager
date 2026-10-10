/**
 * A stored WAF rule the directive filter drops is left out of the config, and the warning names
 * where it is stored so an operator can find the rule that stopped applying. A global rule dropped
 * only in one host's handler names that host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost, type WafHostConfig } from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import { setSetting } from '../../../src/lib/settings';
import type { WafSettings } from '../../../src/lib/settings';
import * as schema from '../../../src/lib/db/schema';

// Unique to this file: the warning is deduplicated per source and content for the module's life.
const DROPPED_RULE = 'SecRule ARGS "@pmFromFile /etc/cpm-warn-test.data" "id:7301,phase:2,deny"';
const GLOBAL_DROPPED_RULE =
  'SecRule ARGS "@pmFromFile /etc/cpm-warn-global.data" "id:7302,phase:2,deny"';
const HOST_DROPPED_RULE =
  'SecRule ARGS "@pmFromFile /etc/cpm-warn-merge-host.data" "id:7303,phase:2,deny"';
const GLOBAL_CRS_RULE =
  'SecRule ARGS "@pmFromFile @owasp_crs/unix-shell.data" "id:7304,phase:2,deny"';
const SHARED_ID_RULE =
  'SecRule REQUEST_URI "@beginsWith /cpm-warn-dup/" "id:7305,phase:1,pass,nolog"';

/** Stored directly, as a row from before a filter rule: the validators refuse them on save. */
async function storeGlobalWaf(waf: WafSettings) {
  // Strict: only the strict setting drops a file-reading rule.
  await setSetting('waf', { strict_directives: true, ...waf });
}

/** The strict setting alone, for a host whose own rules are the subject. */
async function storeStrictGlobalWaf() {
  await storeGlobalWaf({
    enabled: false,
    mode: 'Off',
    load_owasp_crs: false,
    custom_directives: '',
  });
}

async function storeHostDirectives(hostId: number, waf: WafHostConfig, customDirectives: string) {
  const row = await ctx.db.query.proxyHosts.findFirst({ where: (t, { eq }) => eq(t.id, hostId) });
  const meta = JSON.parse(row?.meta ?? '{}');
  await ctx.db
    .update(schema.proxyHosts)
    .set({
      meta: JSON.stringify({ ...meta, waf: { ...waf, custom_directives: customDirectives } }),
    })
    .where(eq(schema.proxyHosts.id, hostId));
}

// From the start of each test: creating a host applies the config, which warns then, and once.
let warn: ReturnType<typeof vi.spyOn>;

async function warningsDuring(build: () => Promise<unknown>): Promise<[string, string[]]> {
  const document = JSON.stringify(await build());
  return [document, warn.mock.calls.map((args: unknown[]) => String(args[0]))];
}

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users).catch(() => {});
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dropped per-host WAF directives', () => {
  it('leaves the rule out of the config and names the host in the warning', async () => {
    await storeStrictGlobalWaf();
    const waf: WafHostConfig = {
      enabled: true,
      waf_mode: 'override',
      mode: 'On',
      custom_directives: '',
    };
    const host = await createProxyHost(
      {
        name: 'Legacy WAF',
        domains: ['legacy-waf.example.com'],
        upstreams: ['10.0.0.5:8080'],
        waf,
      },
      1,
    );
    await storeHostDirectives(host.id, waf, DROPPED_RULE);

    const [document, messages] = await warningsDuring(() => buildCaddyDocument());

    expect(document).toContain('"handler":"waf"');
    expect(document).not.toContain('cpm-warn-test');
    const dropped = messages.find((message) => message.includes('cpm-warn-test'));
    expect(dropped).toContain('proxy host "Legacy WAF" (legacy-waf.example.com)');
  });
});

describe('dropped global WAF directives', () => {
  it('reports a global line once under the global settings and a host line under that host', async () => {
    await storeGlobalWaf({
      enabled: true,
      mode: 'On',
      load_owasp_crs: false,
      custom_directives: `# kept\n${GLOBAL_DROPPED_RULE}`,
    });
    const merge: WafHostConfig = { enabled: true, waf_mode: 'merge', custom_directives: '' };
    for (const [name, domain] of [
      ['Merge A', 'merge-a.example.com'],
      ['Merge B', 'merge-b.example.com'],
    ]) {
      await createProxyHost(
        { name, domains: [domain], upstreams: ['10.0.0.6:8080'], waf: merge },
        1,
      );
    }
    await createProxyHost(
      { name: 'Inherit C', domains: ['inherit-c.example.com'], upstreams: ['10.0.0.8:8080'] },
      1,
    );
    const hostD = await createProxyHost(
      {
        name: 'Merge D',
        domains: ['merge-d.example.com'],
        upstreams: ['10.0.0.9:8080'],
        waf: merge,
      },
      1,
    );
    await storeHostDirectives(hostD.id, merge, HOST_DROPPED_RULE);

    const [document, messages] = await warningsDuring(() => buildCaddyDocument());

    expect(document).not.toContain('cpm-warn-global');
    expect(document).not.toContain('cpm-warn-merge-host');
    const globalWarnings = messages.filter((message) => message.includes('cpm-warn-global'));
    expect(globalWarnings).toHaveLength(1);
    expect(globalWarnings[0]).toContain('[waf] global WAF settings:');
    expect(globalWarnings[0]).not.toContain('proxy host');
    expect(globalWarnings[0]).not.toContain('cpm-warn-merge-host');
    const hostWarnings = messages.filter((message) => message.includes('cpm-warn-merge-host'));
    expect(hostWarnings).toHaveLength(1);
    expect(hostWarnings[0]).toContain('[waf] proxy host "Merge D" (merge-d.example.com):');
    expect(hostWarnings[0]).not.toContain('cpm-warn-global');
  });
});

describe("global WAF directives dropped in one host's handler only", () => {
  it('names the host whose CRS setting drops a global rule, and keeps it for the others', async () => {
    await storeGlobalWaf({
      enabled: true,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: GLOBAL_CRS_RULE,
    });
    await createProxyHost(
      {
        name: 'CRS Off',
        domains: ['crs-off.example.com'],
        upstreams: ['10.0.0.10:8080'],
        waf: { enabled: true, waf_mode: 'merge', load_owasp_crs: false },
      },
      1,
    );
    await createProxyHost(
      { name: 'Inherit E', domains: ['inherit-e.example.com'], upstreams: ['10.0.0.11:8080'] },
      1,
    );

    const [document, all] = await warningsDuring(() => buildCaddyDocument());

    expect(document.match(/id:7304,/g)).toHaveLength(1);
    const messages = all.filter((message) => message.includes('id:7304'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      '[waf] proxy host "CRS Off" (crs-off.example.com), from the global WAF settings:',
    );
  });

  it('drops a host rule reusing a global rule id under the host', async () => {
    await storeGlobalWaf({
      enabled: true,
      mode: 'On',
      load_owasp_crs: false,
      custom_directives: SHARED_ID_RULE,
    });
    const merge: WafHostConfig = { enabled: true, waf_mode: 'merge', custom_directives: '' };
    const host = await createProxyHost(
      { name: 'Dup F', domains: ['dup-f.example.com'], upstreams: ['10.0.0.12:8080'], waf: merge },
      1,
    );
    await storeHostDirectives(
      host.id,
      merge,
      SHARED_ID_RULE.replace('/cpm-warn-dup/', '/cpm-warn-dup-host/'),
    );

    const [document, all] = await warningsDuring(() => buildCaddyDocument());

    expect(document).toContain('/cpm-warn-dup/');
    expect(document).not.toContain('/cpm-warn-dup-host/');
    const messages = all.filter((message) => message.includes('cpm-warn-dup'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('[waf] proxy host "Dup F" (dup-f.example.com):');
    expect(messages[0]).toContain('rule id 7305 is already used');
  });
});
