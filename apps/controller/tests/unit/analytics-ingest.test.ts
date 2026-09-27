/**
 * Agents are less trusted, so relayed rows are rebuilt field by field. A bad row is dropped and
 * counted, not fatal: a refused batch is resent every pass and would stall analytics for good.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const ctx = vi.hoisted(() => ({
  enabled: true,
  writes: [] as { table: string; rows: unknown[]; agentId: string }[],
}));

vi.mock('@/src/lib/clickhouse/client', () => ({
  isAnalyticsEnabled: async () => ctx.enabled,
  insertTrafficEvents: async (rows: unknown[], agentId: string) => {
    ctx.writes.push({ table: 'traffic', rows, agentId });
  },
  insertWafEvents: async (rows: unknown[], agentId: string) => {
    ctx.writes.push({ table: 'waf', rows, agentId });
  },
}));

const { ingestAnalytics, parseTrafficRow, parseWafRow } = await import(
  '@/src/lib/agent/analytics-ingest'
);

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

beforeEach(() => {
  ctx.enabled = true;
  ctx.writes = [];
});

describe('parseTrafficRow', () => {
  it('keeps a well-formed row, fractional timestamp included, and nothing it did not ask for', () => {
    expect(parseTrafficRow({ ...traffic, agent_id: 'someone-else', extra: 1 })).toEqual(traffic);
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
});

describe('ingestAnalytics', () => {
  it('writes the good rows stamped with the agent that sent them, and counts the rest', async () => {
    const result = await ingestAnalytics('edge-1', 'traffic', [traffic, { nope: true }, traffic]);

    expect(result).toEqual({ accepted: 2, rejected: 1 });
    expect(ctx.writes).toEqual([{ table: 'traffic', rows: [traffic, traffic], agentId: 'edge-1' }]);
  });

  it('writes WAF rows to their own table', async () => {
    await ingestAnalytics('edge-1', 'waf', [waf]);
    expect(ctx.writes.map((write) => write.table)).toEqual(['waf']);
  });

  it('refuses a kind it does not know', async () => {
    await expect(ingestAnalytics('edge-1', 'metrics', [traffic])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(ctx.writes).toEqual([]);
  });

  it('refuses while analytics are off, so the agent keeps the rows rather than losing them', async () => {
    ctx.enabled = false;

    await expect(ingestAnalytics('edge-1', 'traffic', [traffic])).rejects.toMatchObject({
      code: 'ANALYTICS_DISABLED',
    });
    expect(ctx.writes).toEqual([]);
  });
});
