import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { fresh } from '@/tests/helpers/fresh';
import type { SettingDefinition } from '@/src/lib/settings/registry';

/**
 * resolve.ts's environment layer with nothing stored, so `stubEnv` reaches the client without a
 * schema per test. Whether a stored value wins is tested in resolve.ts's own suite.
 */
vi.mock('@/src/lib/settings/resolve', () => ({
  getSetting: async (definition: SettingDefinition) => {
    const raw = process.env[definition.env];
    if (raw === undefined) return definition.default;
    if (raw.trim() === '' && definition.default !== null) return definition.default;
    try {
      return definition.fromEnv(raw);
    } catch {
      return definition.default;
    }
  },
}));

describe('clickhouse client analytics enablement', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats analytics as enabled when CLICKHOUSE_PASSWORD is configured before init runs', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    const query = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => [{ total: '12', unique_ips: '4', blocked: '2', bytes: '1024' }],
      })
      .mockResolvedValueOnce({ json: async () => [{ waf_blocked: '3' }] });

    const createClient = vi.fn(() => ({
      query,
      command: vi.fn(),
      insert: vi.fn(),
      close: vi.fn(),
    }));

    vi.mock('@clickhouse/client', () => ({
      createClient,
    }));

    const { isAnalyticsEnabled, querySummary } = await import(
      `@/src/lib/clickhouse/client${fresh()}`
    );

    await expect(isAnalyticsEnabled()).resolves.toBe(true);

    await expect(querySummary(0, 60, [])).resolves.toEqual({
      totalRequests: 12,
      uniqueIps: 4,
      blockedRequests: 5,
      blockedPercent: 41.7,
      bytesServed: 1024,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        log: { level: 127 },
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 0,
        },
      }),
    );
  });

  it('treats analytics as disabled when CLICKHOUSE_PASSWORD is missing', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', '');

    const createClient = vi.fn();
    vi.mock('@clickhouse/client', () => ({ createClient }));

    const { isAnalyticsEnabled, querySummary } = await import(
      `@/src/lib/clickhouse/client${fresh()}`
    );

    await expect(isAnalyticsEnabled()).resolves.toBe(false);

    await expect(querySummary(0, 60, [])).resolves.toEqual({
      totalRequests: 0,
      uniqueIps: 0,
      blockedRequests: 0,
      blockedPercent: 0,
      bytesServed: 0,
    });

    expect(createClient).not.toHaveBeenCalled();
  });

  it('defaults retention to 30 days and creates tables with a 30-day TTL', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');
    vi.stubEnv('CLICKHOUSE_RETENTION_DAYS', '');

    const commands: string[] = [];
    const command = vi.fn(async ({ query }: { query: string }) => {
      commands.push(query);
    });
    // ensureRetentionTtl reads the live TTL; report it already matches 30 days.
    const query = vi.fn(async () => ({
      json: async () => [{ create_table_query: 'TTL ts + toIntervalDay(30)' }],
    }));

    vi.mock('@clickhouse/client', () => ({
      createClient: vi.fn(() => ({ query, command, insert: vi.fn(), close: vi.fn() })),
    }));

    const { getRetentionDays, initClickHouse } = await import(
      `@/src/lib/clickhouse/client${fresh()}`
    );
    await expect(getRetentionDays()).resolves.toBe(30);

    await initClickHouse();

    const trafficDdl = commands.find((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS traffic_events'),
    );
    const wafDdl = commands.find((q) => q.includes('CREATE TABLE IF NOT EXISTS waf_events'));
    expect(trafficDdl).toContain('TTL ts + INTERVAL 30 DAY DELETE');
    expect(wafDdl).toContain('TTL ts + INTERVAL 30 DAY DELETE');
    expect(commands.some((q) => q.includes('MODIFY TTL'))).toBe(false);
  });

  it('honors a custom retention value and migrates an existing table whose TTL differs', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');
    vi.stubEnv('CLICKHOUSE_RETENTION_DAYS', '7');

    const commands: string[] = [];
    const command = vi.fn(async ({ query }: { query: string }) => {
      commands.push(query);
    });
    // Existing tables were created under the old 90-day TTL.
    const query = vi.fn(async () => ({
      json: async () => [{ create_table_query: 'TTL ts + toIntervalDay(90)' }],
    }));

    vi.mock('@clickhouse/client', () => ({
      createClient: vi.fn(() => ({ query, command, insert: vi.fn(), close: vi.fn() })),
    }));

    const { getRetentionDays, initClickHouse } = await import(
      `@/src/lib/clickhouse/client${fresh()}`
    );
    await expect(getRetentionDays()).resolves.toBe(7);

    await initClickHouse();

    expect(commands.find((q) => q.includes('CREATE TABLE IF NOT EXISTS traffic_events'))).toContain(
      'TTL ts + INTERVAL 7 DAY DELETE',
    );
    const modifies = commands.filter((q) =>
      /ALTER TABLE \w+ MODIFY TTL ts \+ INTERVAL 7 DAY DELETE/.test(q),
    );
    expect(modifies).toHaveLength(2);
  });

  // An unusable value is a warning, not fatal: a typo in one variable must not stop the proxy.
  it('falls back to the default when CLICKHOUSE_RETENTION_DAYS is not a positive integer', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');
    vi.stubEnv('CLICKHOUSE_RETENTION_DAYS', 'not-a-number');
    vi.mock('@clickhouse/client', () => ({ createClient: vi.fn() }));

    const { getRetentionDays } = await import(`@/src/lib/clickhouse/client${fresh()}`);
    await expect(getRetentionDays()).resolves.toBe(30);
  });

  // Answers the system.tables enumeration with `liveTables`, and anything else (the retention
  // read) with a matching 30-day TTL.
  function mockClient(
    liveTables: string[],
    commandImpl?: (q: string) => void,
    insert: (...args: unknown[]) => unknown = vi.fn(),
  ) {
    const calls: {
      command: string[];
      queries: { query: string; params?: Record<string, unknown> }[];
    } = {
      command: [],
      queries: [],
    };
    const command = vi.fn(async ({ query }: { query: string }) => {
      calls.command.push(query);
      commandImpl?.(query);
    });
    const query = vi.fn(
      async ({
        query,
        query_params,
      }: {
        query: string;
        query_params?: Record<string, unknown>;
      }) => {
        calls.queries.push({ query, params: query_params });
        if (query.includes('FROM system.tables') && query.includes('match(name')) {
          return { json: async () => liveTables.map((name) => ({ name })) };
        }
        return { json: async () => [{ create_table_query: 'TTL ts + toIntervalDay(30)' }] };
      },
    );
    vi.mock('@clickhouse/client', () => ({
      createClient: vi.fn(() => ({ query, command, insert, close: vi.fn() })),
    }));
    return calls;
  }

  it('drops every disabled system-log table that exists, including numbered upgrade leftovers', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    // Includes _N copies from past upgrades.
    const liveTables = [
      'trace_log',
      'trace_log_3',
      'trace_log_5',
      'metric_log',
      'metric_log_0',
      'histogram_metric_log',
    ];
    const calls = mockClient(liveTables);

    const { initClickHouse } = await import(`@/src/lib/clickhouse/client${fresh()}`);
    await initClickHouse();

    const enumeration = calls.queries.find((q) => q.query.includes('match(name'));
    expect(enumeration?.params?.pattern).toBe(
      '^(metric_log|asynchronous_metric_log|trace_log|query_log|query_thread_log|query_views_log|' +
        'part_log|processors_profile_log|text_log|session_log|opentelemetry_span_log|blob_storage_log|' +
        'backup_log|histogram_metric_log)(_[0-9]+)?$',
    );

    // Exactly the tables that exist are dropped - the _N leftovers included.
    for (const name of liveTables) {
      expect(calls.command).toContain(`DROP TABLE IF EXISTS system.${name} SYNC`);
    }
    const drops = calls.command.filter((q) => q.startsWith('DROP TABLE IF EXISTS system.'));
    expect(drops).toHaveLength(liveTables.length);
  });

  it('does not abort init when dropping system-log tables fails (insufficient privileges)', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    const dropAttempts: string[] = [];
    const calls = mockClient(['trace_log', 'metric_log', 'part_log'], (q) => {
      if (q.startsWith('DROP TABLE IF EXISTS system.')) {
        dropAttempts.push(q);
        throw new Error(
          'Not enough privileges. To execute this query, it is necessary to have the grant DROP TABLE',
        );
      }
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { initClickHouse } = await import(`@/src/lib/clickhouse/client${fresh()}`);
    // Best-effort: a privilege error must not reject and abort startup.
    await expect(initClickHouse()).resolves.toBeUndefined();

    // Bails out after the first failure rather than spamming a warning per table.
    expect(dropAttempts).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('could not drop disabled system log tables');
    void calls;

    warn.mockRestore();
  });

  const trafficRow = {
    ts: 1_700_000_000,
    client_ip: '203.0.113.9',
    country_code: null,
    host: 'app.example.com',
    method: 'GET',
    uri: '/',
    status: 200,
    proto: 'HTTP/2.0',
    bytes_sent: 10,
    user_agent: 'curl/8',
    is_blocked: false,
  };

  // A fresh install: the agent starts ClickHouse only after the controller has booted.
  it('creates the schema on the first insert after a failed startup init, and only once', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    let reachable = false;
    const insert = vi.fn(async () => {});
    const calls = mockClient(
      [],
      () => {
        if (!reachable) throw new Error('getaddrinfo ENOTFOUND clickhouse');
      },
      insert,
    );

    const { initClickHouse, insertTrafficEvents } = await import(
      `@/src/lib/clickhouse/client${fresh()}`
    );
    await expect(initClickHouse()).rejects.toThrow('ENOTFOUND');

    reachable = true;
    await insertTrafficEvents([trafficRow], 'agent-1');
    await insertTrafficEvents([trafficRow], 'agent-1');

    const ddl = calls.command.filter((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS traffic_events'),
    );
    expect(ddl).toHaveLength(1);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('recreates a schema that vanished under a running controller and retries once', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    const unknownTable = Object.assign(new Error('Table analytics.traffic_events does not exist'), {
      code: '60',
    });
    const insert = vi.fn().mockRejectedValueOnce(unknownTable).mockResolvedValue(undefined);
    const calls = mockClient([], undefined, insert);

    const { initClickHouse, insertTrafficEvents } = await import(
      `@/src/lib/clickhouse/client${fresh()}`
    );
    await initClickHouse();
    await insertTrafficEvents([trafficRow]);

    const ddl = calls.command.filter((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS traffic_events'),
    );
    expect(ddl).toHaveLength(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('re-checks the schema after the analytics settings are saved', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    const calls = mockClient([]);
    const { initClickHouse, insertTrafficEvents, invalidateClickHouseConfig } = await import(
      `@/src/lib/clickhouse/client${fresh()}`
    );
    await initClickHouse();
    await invalidateClickHouseConfig();
    await insertTrafficEvents([trafficRow]);

    const ddl = calls.command.filter((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS traffic_events'),
    );
    expect(ddl).toHaveLength(2);
  });

  it('returns full WAF stats for the filtered result set', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    const query = vi.fn().mockResolvedValueOnce({
      json: async () => [
        {
          total: '5400',
          blocked: '5400',
          critical: '5400',
          unique_hosts: '1',
          rule_ids_triggered: '3',
        },
      ],
    });

    vi.mock('@clickhouse/client', () => ({
      createClient: vi.fn(() => ({ query, command: vi.fn(), insert: vi.fn(), close: vi.fn() })),
    }));

    const { queryWafEventStatsWithSearch } = await import(`@/src/lib/clickhouse/client${fresh()}`);

    await expect(queryWafEventStatsWithSearch('example.com')).resolves.toEqual({
      total: 5400,
      blocked: 5400,
      critical: 5400,
      uniqueHosts: 1,
      ruleIdsTriggered: 3,
    });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('narrows WAF events on each structured filter, binding every value as a parameter', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');

    const query = vi.fn().mockResolvedValue({ json: async () => [{ value: '0' }] });
    vi.mock('@clickhouse/client', () => ({
      createClient: vi.fn(() => ({ query, command: vi.fn(), insert: vi.fn(), close: vi.fn() })),
    }));

    const { queryWafCountWithSearch } = await import(`@/src/lib/clickhouse/client${fresh()}`);
    await queryWafCountWithSearch({
      search: "' OR 1=1",
      host: 'app.example.com',
      clientIp: '203.0.113.9',
      ruleId: 942100,
      blocked: false,
      severity: 'critical',
    });

    const [{ query: sql, query_params }] = query.mock.calls[0];
    expect(sql).toContain('startsWith(host, concat({p_host:String}');
    expect(sql).toContain('client_ip = {p_client_ip:String}');
    expect(sql).toContain('rule_id = {p_rule_id:Int32}');
    expect(sql).toContain('blocked = {p_blocked:Bool}');
    expect(sql).not.toContain('OR 1=1');
    expect(query_params).toMatchObject({
      p_search: "%' OR 1=1%",
      p_host: 'app.example.com',
      p_client_ip: '203.0.113.9',
      p_rule_id: 942100,
      p_blocked: false,
      p_severity: 'critical',
    });
  });
});

describe('per-country analytics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Answers by SQL, since the breakdown's three parallel queries land in any order. */
  function clientAnswering(answers: { match: RegExp; rows: unknown[] }[]) {
    const calls: { query: string; query_params: Record<string, unknown> }[] = [];
    const query = vi.fn(async (args: { query: string; query_params: Record<string, unknown> }) => {
      calls.push(args);
      const hit = answers.find((a) => a.match.test(args.query));
      return { json: async () => hit?.rows ?? [] };
    });
    vi.mock('@clickhouse/client', () => ({
      createClient: vi.fn(() => ({ query, command: vi.fn(), insert: vi.fn(), close: vi.fn() })),
    }));
    return calls;
  }

  it('reports unique client IPs per country beside requests and blocks', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');
    clientAnswering([
      {
        match: /GROUP BY country_code/,
        rows: [
          { country_code: 'DE', total: '120', blocked: '2', unique_ips: '31' },
          { country_code: null, total: '4', blocked: '0', unique_ips: '3' },
        ],
      },
    ]);

    const { queryCountries } = await import(`@/src/lib/clickhouse/client${fresh()}`);

    await expect(queryCountries(0, 1, [])).resolves.toEqual([
      { countryCode: 'DE', total: 120, blocked: 2, uniqueIps: 31 },
      // Unplaced rows keep their "XX" code, which the breakdown then has to understand.
      { countryCode: 'XX', total: 4, blocked: 0, uniqueIps: 3 },
    ]);
  });

  it('breaks one country down into hosts, response classes and user agents', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');
    const calls = clientAnswering([
      {
        match: /uniqExact\(client_ip\)/,
        rows: [
          {
            total: '100',
            blocked: '3',
            unique_ips: '12',
            ok: '80',
            redirects: '5',
            client_errors: '12',
            server_errors: '3',
          },
        ],
      },
      {
        match: /GROUP BY host/,
        rows: [
          { host: 'media.example.com', count: '60' },
          { host: '', count: '40' },
        ],
      },
      { match: /GROUP BY user_agent/, rows: [{ user_agent: 'curl/8.7.1', count: '9' }] },
    ]);

    const { queryCountryBreakdown } = await import(`@/src/lib/clickhouse/client${fresh()}`);

    await expect(queryCountryBreakdown(0, 1, [], 'DE')).resolves.toEqual({
      countryCode: 'DE',
      total: 100,
      blocked: 3,
      uniqueIps: 12,
      hosts: [
        { host: 'media.example.com', count: 60 },
        { host: 'Unknown', count: 40 },
      ],
      statusClasses: { ok: 80, redirects: 5, clientErrors: 12, serverErrors: 3 },
      userAgents: [{ userAgent: 'curl/8.7.1', count: 9 }],
    });

    // The code is bound as a parameter on every query, never spliced into the SQL.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.query).toContain('country_code = {country:String}');
      expect(call.query_params.country).toBe('DE');
      expect(call.query).not.toContain("'DE'");
    }
  });

  it('selects the unplaced rows for XX instead of matching a literal code', async () => {
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'test-clickhouse-password');
    const calls = clientAnswering([]);

    const { queryCountryBreakdown } = await import(`@/src/lib/clickhouse/client${fresh()}`);
    const result = await queryCountryBreakdown(0, 1, [], 'XX');

    // "XX" is GeoIP's unplaced bucket; matching it literally would open an empty breakdown.
    for (const call of calls) {
      expect(call.query).toContain('country_code IS NULL');
      expect(call.query).not.toContain('{country:String}');
    }
    expect(result.total).toBe(0);
    expect(result.hosts).toEqual([]);
  });
});
