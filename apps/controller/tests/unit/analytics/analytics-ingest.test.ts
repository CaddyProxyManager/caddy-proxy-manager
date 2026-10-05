/**
 * Agents are less trusted, so relayed rows are rebuilt field by field. A bad row is dropped and
 * counted, not fatal: a refused batch is resent every pass and would stall analytics for good.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  enabled: true,
  writes: [] as { table: string; rows: unknown[]; agentId: string }[],
  db: null as unknown as TestDb,
}));

const { createTestDb } = await import('@/tests/helpers/db');
vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('@/src/lib/clickhouse/client', () => ({
  isAnalyticsEnabled: async () => ctx.enabled,
  insertTrafficEvents: async (rows: unknown[], agentId: string) => {
    ctx.writes.push({ table: 'traffic', rows, agentId });
  },
  insertWafEvents: async (rows: unknown[], agentId: string) => {
    ctx.writes.push({ table: 'waf', rows, agentId });
  },
}));

const { bareHost, ingestAnalytics, parseTrafficRow, parseWafRow } = await import(
  '@/src/lib/agent/analytics-ingest'
);
const { agents, proxyHostAgents, proxyHosts } = await import('@/src/lib/db/schema');

const traffic = {
  ts: 1_757_000_000.25,
  client_ip: '203.0.113.9',
  country_code: 'DE',
  host: 'example.com',
  method: 'GET',
  uri: '/',
  status: 200,
  proto: 'HTTP/2.0',
  bytes_sent: 512,
  user_agent: 'curl/8',
  is_blocked: false,
};

const waf = {
  ts: 1_757_000_000,
  host: 'example.com',
  client_ip: '203.0.113.9',
  country_code: null,
  rule_id: 942100,
  rule_message: 'SQL injection',
  severity: 'critical',
  raw_data: null,
  blocked: true,
  method: 'POST',
  uri: '/login',
};

beforeEach(async () => {
  ctx.enabled = true;
  ctx.writes = [];
  ctx.db = await createTestDb();
});

async function agent(name: string): Promise<number> {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(agents)
    .values({ name, agentId: name, secret: 'x', createdAt: now, updatedAt: now })
    .returning();
  return row.id;
}

async function host(domains: string[], pinnedTo: number[] = []): Promise<void> {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(proxyHosts)
    .values({
      name: domains[0],
      domains: JSON.stringify(domains),
      upstreams: '["app:80"]',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  for (const agentId of pinnedTo) {
    await ctx.db.insert(proxyHostAgents).values({ proxyHostId: row.id, agentId, createdAt: now });
  }
}

describe('parseTrafficRow', () => {
  it('keeps a well-formed row, fractional timestamp included, and nothing it did not ask for', () => {
    expect(parseTrafficRow({ ...traffic, agent_id: 'someone-else', extra: 1 })).toEqual({
      ...traffic,
      duration_ms: null,
      outcome: 'served',
      asn: null,
      asn_org: null,
    });
  });

  it("keeps a newer agent's outcome, duration and ASN", () => {
    const row = {
      ...traffic,
      duration_ms: 42,
      outcome: 'waf' as const,
      asn: 64500,
      asn_org: 'Example',
    };
    expect(parseTrafficRow(row)).toEqual(row);
  });

  it("reads an older agent's blocker row as geo", () => {
    expect(parseTrafficRow({ ...traffic, is_blocked: true })?.outcome).toBe('geo');
  });

  it('counts an outcome it has no name for as served rather than dropping the row', () => {
    expect(parseTrafficRow({ ...traffic, outcome: 'from-the-future' })?.outcome).toBe('served');
  });

  it('drops a row with a field of the wrong type or out of range', () => {
    for (const bad of [
      { ...traffic, status: '200' },
      { ...traffic, status: 70_000 },
      { ...traffic, ts: -1 },
      { ...traffic, ts: Number.NaN },
      { ...traffic, is_blocked: 'false' },
      { ...traffic, bytes_sent: 1.5 },
      { ...traffic, uri: 'x'.repeat(64 * 1024 + 1) },
      { ...traffic, host: undefined },
      { ...traffic, duration_ms: -1 },
      { ...traffic, duration_ms: 1.5 },
      { ...traffic, asn: 'AS1' },
      { ...traffic, asn_org: 7 },
    ]) {
      expect(parseTrafficRow(bad)).toBeNull();
    }
  });

  it('drops something that is not a row at all', () => {
    expect(parseTrafficRow(null)).toBeNull();
    expect(parseTrafficRow([traffic])).toBeNull();
    expect(parseTrafficRow('row')).toBeNull();
  });
});

describe('parseWafRow', () => {
  it('keeps a well-formed row with its optional fields empty', () => {
    const sparse = { ...waf, rule_id: null, rule_message: null, severity: null };
    expect(parseWafRow(sparse)).toEqual(sparse);
  });

  it('gives audit data more room than other fields, but not unlimited room', () => {
    expect(parseWafRow({ ...waf, raw_data: 'x'.repeat(512 * 1024) })).not.toBeNull();
    expect(parseWafRow({ ...waf, raw_data: 'x'.repeat(1024 * 1024 + 1) })).toBeNull();
  });

  it('drops a rule id that is not a whole 32-bit number', () => {
    expect(parseWafRow({ ...waf, rule_id: 1.5 })).toBeNull();
    expect(parseWafRow({ ...waf, rule_id: 2 ** 31 })).toBeNull();
  });

  // An agent from before redaction sends the audit entry raw, and the controller stores it.
  it('redacts what an older agent sent unredacted, and leaves a redacted row as it is', () => {
    const entry = {
      transaction: {
        id: 'tx-old',
        client_ip: '203.0.113.9',
        unix_timestamp: 1,
        request: {
          method: 'GET',
          uri: '/feed?token=URI-SECRET&q=1',
          headers: { host: ['example.com'], cookie: ['session=COOKIE-SECRET'] },
        },
      },
      messages: [
        {
          error_message:
            '[id "942100"] [msg "SQLi"] [data "Matched Data: x found within REQUEST_COOKIES:session: COOKIE-SECRET"]',
        },
      ],
    };
    // Nanoseconds past a JS number's precision, as Coraza writes them.
    const raw = JSON.stringify(entry).replace(
      '"unix_timestamp":1',
      '"unix_timestamp":1700000000123456789',
    );
    const row = parseWafRow({
      ...waf,
      uri: '/feed?token=URI-SECRET&q=1',
      rule_message: 'REQUEST_COOKIES:session=MSG-SECRET',
      raw_data: raw,
    });
    expect(row?.uri).toBe('/feed?token=[redacted]&q=1');
    expect(row?.rule_message).toBe('REQUEST_COOKIES:session=[redacted]');
    expect(row?.raw_data).not.toMatch(/SECRET/);
    expect(row?.raw_data).toContain('"unix_timestamp":1700000000123456789');
    expect(parseWafRow(row)).toEqual(row);
  });

  it('drops audit data it cannot read as an audit entry', () => {
    expect(parseWafRow({ ...waf, raw_data: 'cookie: session=SECRET' })?.raw_data).toBeNull();
  });
});

describe('ingestAnalytics', () => {
  it('writes the good rows stamped with the agent that sent them, and counts the rest', async () => {
    const result = await ingestAnalytics(
      'edge-1',
      'traffic',
      [traffic, { nope: true }, traffic],
      1,
    );

    expect(result).toEqual({ accepted: 2, rejected: 1 });
    const stored = { ...traffic, duration_ms: null, outcome: 'served', asn: null, asn_org: null };
    expect(ctx.writes).toEqual([{ table: 'traffic', rows: [stored, stored], agentId: 'edge-1' }]);
  });

  it('drops rows for a host pinned only to other agents, and keeps what it serves', async () => {
    const edge = await agent('edge-1');
    const other = await agent('edge-2');
    await host(['mine.example.com'], [edge]);
    await host(['theirs.example.com'], [other]);
    await host(['*.shared.example.com']);
    const rows = [
      { ...waf, host: 'mine.example.com:443' },
      { ...waf, host: 'THEIRS.example.com' },
      { ...waf, host: 'a.shared.example.com' },
      { ...waf, host: '203.0.113.1' },
    ];
    const result = await ingestAnalytics('edge-1', 'waf', rows, edge);
    expect(result).toEqual({ accepted: 3, rejected: 1 });
    expect(ctx.writes[0].rows.map((row) => (row as { host: string }).host)).toEqual([
      'mine.example.com',
      'a.shared.example.com',
      '203.0.113.1',
    ]);
  });

  it('strips the port from a host, IPv6 included', () => {
    expect(bareHost('App.Example.com:8443')).toBe('app.example.com');
    expect(bareHost('[2001:db8::1]:443')).toBe('[2001:db8::1]');
    expect(bareHost('2001:db8::1')).toBe('2001:db8::1');
  });

  it('writes WAF rows to their own table', async () => {
    await ingestAnalytics('edge-1', 'waf', [waf], 1);
    expect(ctx.writes.map((write) => write.table)).toEqual(['waf']);
  });

  it('refuses a kind it does not know', async () => {
    await expect(ingestAnalytics('edge-1', 'metrics', [traffic], 1)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses while analytics are off, so the agent keeps the rows rather than losing them', async () => {
    ctx.enabled = false;

    await expect(ingestAnalytics('edge-1', 'traffic', [traffic], 1)).rejects.toMatchObject({
      code: 'ANALYTICS_DISABLED',
    });
    expect(ctx.writes).toEqual([]);
  });
});
