/**
 * WAF event ingestion (#233): a real block is *recorded*, audit log to page, with its rule set.
 * The tick-boundary race is pinned in waf-log-parser.test.ts. Domain: func-waf-ingest.test
 */
import { test, expect, type Page } from '@playwright/test';
import { createProxyHost } from '../../helpers/proxy-api';
import { ANALYTICS_OFF } from '../../helpers/compose';
import { httpGet, waitForRoute } from '../../helpers/http';

const DOMAIN = 'func-waf-ingest.test';

// The parser polls every 30s; allow more than one cycle.
const INGEST_TIMEOUT_MS = 100_000;
const POLL_INTERVAL_MS = 3_000;

interface WafEvent {
  ts: number;
  host: string;
  clientIp: string;
  method: string;
  uri: string;
  ruleId: number | null;
  ruleMessage: string | null;
  severity: string | null;
  blocked: boolean;
}

async function fetchWafEvents(page: Page): Promise<WafEvent[]> {
  const res = await page.request.get('/api/waf-events?per_page=200');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { events: WafEvent[] };
  return body.events;
}

/** Poll /api/waf-events until an event matching `predicate` shows up. */
async function waitForWafEvent(
  page: Page,
  predicate: (e: WafEvent) => boolean,
  timeoutMs = INGEST_TIMEOUT_MS,
): Promise<WafEvent> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  while (Date.now() < deadline) {
    const events = await fetchWafEvents(page);
    seen = events.length;
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`No matching WAF event within ${timeoutMs}ms (${seen} events visible)`);
}

test.describe
  .serial('WAF event ingestion', () => {
    // WAF events are stored in ClickHouse.
    test.skip(ANALYTICS_OFF, 'no ClickHouse in the analytics-off run');
    test('setup: create proxy host with WAF enabled', async ({ page }) => {
      test.setTimeout(120_000);

      await createProxyHost(page, {
        name: 'Functional WAF Ingestion',
        domain: DOMAIN,
        upstream: 'echo-server:8080',
        enableWaf: true,
      });
      await waitForRoute(DOMAIN);
    });

    test('a blocked attack is recorded as a WAF event with its rule', async ({ page }) => {
      test.setTimeout(INGEST_TIMEOUT_MS + 60_000);

      const res = await httpGet(DOMAIN, '/ingest-blocked?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
      expect(res.status).toBe(403);

      const event = await waitForWafEvent(page, (e) => e.uri.includes('/ingest-blocked'));

      expect(event.blocked).toBe(true);
      expect(event.host).toContain(DOMAIN);
      expect(event.method).toBe('GET');
      // A null rule id was the #233 failure mode.
      expect(event.ruleId).not.toBeNull();
      expect(event.ruleMessage).toBeTruthy();
      expect(event.severity).toBeTruthy();
    });

    test('ingested events are visible on the WAF page', async ({ page }) => {
      test.setTimeout(60_000);

      await page.goto('/waf');
      await expect(page.getByText('/ingest-blocked', { exact: false }).first()).toBeVisible({
        timeout: 20_000,
      });
    });

    test('ordinary traffic does not produce WAF events', async ({ page }) => {
      test.setTimeout(INGEST_TIMEOUT_MS);

      const res = await httpGet(DOMAIN, '/ingest-clean-path');
      expect(res.status).toBe(200);

      // Coraza audit-logs some 4xx/5xx with no rule fired; the parser must drop them.
      await new Promise((r) => setTimeout(r, 70_000));

      const events = await fetchWafEvents(page);
      expect(events.some((e) => e.uri.includes('/ingest-clean-path'))).toBe(false);
    });
  });
