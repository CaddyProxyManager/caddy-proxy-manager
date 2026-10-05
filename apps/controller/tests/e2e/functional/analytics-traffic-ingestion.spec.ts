/**
 * Access-log ingestion end to end: real requests through Caddy, read by the agent from the access
 * log, relayed to the controller and stored in ClickHouse. The other analytics specs insert rows
 * directly; this one writes none. Domain: func-traffic-ingest.test
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@clickhouse/client';
import { httpGet, waitForStatus } from '../../helpers/http';

const ORIGIN = 'http://localhost:3000';
const DOMAIN = 'func-traffic-ingest.test';
const REQUESTS = 6;
// The agent parses every 30s; allow a few cycles.
const INGEST_TIMEOUT_MS = 120_000;

function clickhouse() {
  return createClient({
    url: 'http://localhost:8123',
    username: 'cpm',
    password: 'test-clickhouse-password-2026',
    database: 'analytics',
  });
}

async function clickhouseUp(): Promise<boolean> {
  try {
    return (await fetch('http://localhost:8123/ping', { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

test.describe('Analytics - traffic ingestion', () => {
  test.setTimeout(INGEST_TIMEOUT_MS + 60_000);

  test('requests through Caddy reach ClickHouse and the analytics API', async ({ page }) => {
    test.skip(!(await clickhouseUp()), 'ClickHouse not started (analytics-disabled run)');
    const agent = `cpm-ingest-e2e/${Date.now()}`;
    let hostId: number | undefined;
    const ch = clickhouse();
    const LOGGING = `${ORIGIN}/api/v1/settings/logging`;
    const previousLogging = await (await page.request.get(LOGGING)).json();
    try {
      // Off by default, and nothing is written to the access log the agent reads until it is on.
      const logging = await page.request.put(LOGGING, {
        headers: { Origin: ORIGIN },
        data: { enabled: true, format: 'json' },
      });
      expect(logging.ok(), await logging.text()).toBeTruthy();

      const created = await page.request.post(`${ORIGIN}/api/v1/proxy-hosts`, {
        headers: { Origin: ORIGIN },
        data: {
          name: 'Traffic ingestion',
          domains: [DOMAIN],
          upstreams: ['echo-server:8080'],
          sslForced: false,
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      hostId = (await created.json()).id;
      await waitForStatus(DOMAIN, 200, 20_000);

      for (let i = 0; i < REQUESTS; i++) {
        const res = await httpGet(DOMAIN, `/ingest/${i}?q=1`, { 'User-Agent': agent });
        expect(res.status).toBe(200);
      }

      await expect
        .poll(
          async () => {
            const res = await page.request.get(
              `${ORIGIN}/api/analytics/user-agents?interval=1h&hosts=${DOMAIN}`,
            );
            if (!res.ok()) return 0;
            const rows = (await res.json()) as { userAgent: string; count: number }[];
            return rows.find((row) => row.userAgent === agent)?.count ?? 0;
          },
          { timeout: INGEST_TIMEOUT_MS, intervals: [3_000] },
        )
        .toBe(REQUESTS);

      const rows = await (
        await ch.query({
          query: `SELECT host, method, uri, status, client_ip, outcome, duration_ms
                  FROM traffic_events
                  WHERE user_agent = {agent:String} ORDER BY uri`,
          query_params: { agent },
          format: 'JSONEachRow',
        })
      ).json<{
        host: string;
        method: string;
        uri: string;
        status: number;
        client_ip: string;
        outcome: string;
        duration_ms: number | null;
      }>();
      expect(rows).toHaveLength(REQUESTS);
      for (const row of rows) {
        expect(row.host).toBe(DOMAIN);
        expect(row.method).toBe('GET');
        expect(row.status).toBe(200);
        expect(row.client_ip).not.toBe('');
        // No gate on this host, so nothing marks it and the agent reads it as served.
        expect(row.outcome).toBe('served');
        expect(row.duration_ms).not.toBeNull();
      }
      expect(rows.map((r) => r.uri)).toContain('/ingest/0?q=1');

      // A host with traffic is offered by the analytics host filter.
      const hosts = await page.request.get(`${ORIGIN}/api/analytics/hosts`);
      expect(JSON.stringify(await hosts.json())).toContain(DOMAIN);
    } finally {
      await ch.close();
      await page.request.put(LOGGING, { headers: { Origin: ORIGIN }, data: previousLogging });
      if (hostId !== undefined) {
        await page.request.delete(`${ORIGIN}/api/v1/proxy-hosts/${hostId}`, {
          headers: { Origin: ORIGIN },
        });
      }
    }
  });
});
