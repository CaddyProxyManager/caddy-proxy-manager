/**
 * #117: NETWORKS: 0 in the socket proxy blocked compose's GET /networks/{id}, so applies and the
 * startup republish failed. Creates its own L4 host: file order must not decide the port exists.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { waitForTcpEcho, tcpSend } from '../../helpers/tcp';
import { COMPOSE_CWD } from '../../helpers/compose';
import { ensureL4ProxyHost } from '../../helpers/l4-proxy-api';

const AGENT_CONTAINER = 'caddy-proxy-manager-agent';

// Shared with l4-proxy-routing.spec.ts, which creates the same host when it runs first.
const TCP_PORT = 15432;

const BASE_URL = 'http://localhost:3000';
const ENV = { ...process.env, CLICKHOUSE_PASSWORD: 'test-clickhouse-password-2026' };

// The session CSRF check needs an Origin, which page.request.post() does not send.
const SESSION_HEADERS = { Origin: BASE_URL };

type L4StatusResponse = {
  status: {
    state: string;
    appliedAt?: string;
    message?: string;
    error?: string;
  };
};

async function fetchL4Status(page: Page): Promise<L4StatusResponse> {
  const res = await page.request.get('/api/l4-ports');
  expect(res.ok()).toBe(true);
  return res.json();
}

/** `newerThan` confirms a *new* apply; string comparison is correct for ISO-8601. */
async function waitForL4Terminal(
  page: Page,
  timeoutMs: number,
  newerThan?: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await fetchL4Status(page);
    const state = status?.state as string;
    const appliedAt = status?.appliedAt ?? '';

    const isTerminal = state === 'applied' || state === 'failed';
    const isFresh = !newerThan || appliedAt > newerThan;

    if (isTerminal && isFresh) return state;
    await page.waitForTimeout(2_000);
  }
  throw new Error(`agent did not reach a terminal state within ${timeoutMs}ms`);
}

test.describe
  .serial('Agent', () => {
    test('setup: an enabled L4 host is listening on the TCP port', async ({ page }) => {
      await ensureL4ProxyHost(page, {
        name: 'L4 TCP Echo Test',
        protocol: 'tcp',
        listenAddress: `:${TCP_PORT}`,
        upstream: 'tcp-echo:9000',
      });
    });

    test('apply ports reaches "applied" state', async ({ page }) => {
      // The poll below outlasts the global 60 s timeout.
      test.setTimeout(180_000);

      // The agent republishes unconditionally, so this completes with an unchanged port set.
      const res = await page.request.post('/api/l4-ports', { headers: SESSION_HEADERS });
      expect(res.ok(), `POST /api/l4-ports failed: ${await res.text()}`).toBe(true);

      const state = await waitForL4Terminal(page, 90_000);
      expect(
        state,
        'Expected "applied" but got "failed". Run: docker logs caddy-proxy-manager-agent',
      ).toBe('applied');
    });

    test('TCP traffic works after explicit apply', async () => {
      await waitForTcpEcho('127.0.0.1', TCP_PORT, 'ready-probe', 30_000);
      const res = await tcpSend('127.0.0.1', TCP_PORT, 'agent-apply-check\n');
      expect(res.connected).toBe(true);
      expect(res.data).toContain('agent-apply-check');
    });

    test('auto-applies on agent container restart - regression #117', async ({ page }) => {
      // Restart, republish and Caddy's health check outlast the global 60 s timeout.
      test.setTimeout(180_000);

      // Sleep so the new timestamp is strictly greater whatever the clock's precision.
      const { status: before } = await fetchL4Status(page);
      const prevAppliedAt = before?.appliedAt ?? '';
      await page.waitForTimeout(1_500);

      // The startup republish is what keeps L4 routing alive across a host reboot.
      execFileSync('docker', ['restart', AGENT_CONTAINER], {
        stdio: 'inherit',
        cwd: COMPOSE_CWD,
        env: ENV,
      });

      const state = await waitForL4Terminal(page, 90_000, prevAppliedAt);
      expect(
        state,
        'Agent returned "failed" after restart. ' +
          'Likely cause: docker-socket-proxy is missing NETWORKS: 1. ' +
          'Run: docker logs caddy-proxy-manager-agent',
      ).toBe('applied');
    });

    test('TCP traffic still works after agent restart and auto-apply', async () => {
      // Caddy was briefly recreated; this retries until the route carries data again.
      await waitForTcpEcho('127.0.0.1', TCP_PORT, 'ready-probe', 30_000);
      const res = await tcpSend('127.0.0.1', TCP_PORT, 'after-restart-check\n');
      expect(res.connected).toBe(true);
      expect(res.data).toContain('after-restart-check');
    });
  });
