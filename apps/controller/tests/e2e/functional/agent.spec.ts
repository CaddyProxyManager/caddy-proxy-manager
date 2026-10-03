/**
 * #117: NETWORKS: 0 in the socket proxy blocked compose's GET /networks/{id}, so applies and the
 * startup republish failed. Creates its own L4 host: file order must not decide the port exists.
 * The republish itself, for ports a plain `docker compose up` dropped, is the agent's unit tests':
 * this stack publishes the L4 test ports from its own compose file.
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

function caddyContainerId(): string {
  return execFileSync('docker', ['inspect', '-f', '{{.Id}}', 'caddy-proxy-manager-caddy'], {
    cwd: COMPOSE_CWD,
    encoding: 'utf8',
  }).trim();
}

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

    test('an agent restart starts Caddy again without recreating it - regression #117', async ({
      page,
    }) => {
      // Restart, Caddy's start and the settle below outlast the global 60 s timeout.
      test.setTimeout(180_000);
      const before = caddyContainerId();

      execFileSync('docker', ['restart', AGENT_CONTAINER], {
        stdio: 'inherit',
        cwd: COMPOSE_CWD,
        env: ENV,
      });

      // The agent stops Caddy on its way down and starts the same container on its way up. Its
      // startup restore runs within seconds; a needless republish would recreate the container.
      await waitForTcpEcho('127.0.0.1', TCP_PORT, 'ready-probe', 60_000);
      await page.waitForTimeout(15_000);
      expect(caddyContainerId(), 'Run: docker logs caddy-proxy-manager-agent').toBe(before);
      const { status } = await fetchL4Status(page);
      expect(status.state).toBe('applied');
    });

    test('TCP traffic still works after agent restart', async () => {
      // Caddy was briefly stopped; this retries until the route carries data again.
      await waitForTcpEcho('127.0.0.1', TCP_PORT, 'ready-probe', 30_000);
      const res = await tcpSend('127.0.0.1', TCP_PORT, 'after-restart-check\n');
      expect(res.connected).toBe(true);
      expect(res.data).toContain('after-restart-check');
    });
  });
