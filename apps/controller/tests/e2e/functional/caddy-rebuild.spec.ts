/**
 * An agent-driven Caddy rebuild (CADDY_BUILD_MODE=agent, BuildKit through the socket proxy): the
 * Rate Limit module is selected in Settings -> Caddy Build, which the agent builds. Before,
 * a host's rate limit is skipped for want of the module; after, it answers 429. The module is
 * taken out and Caddy rebuilt again afterwards, which BuildKit mostly serves from cache.
 * Compiling needs the Go module proxy, so this spec needs host egress. Domain: func-ratelimit.test
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { httpGet, waitForStatus } from '../../helpers/http';
import { waitForHydration } from '../../helpers/hydration';

const ORIGIN = 'http://localhost:3000';
const DOMAIN = 'func-ratelimit.test';
const BUILD_TIMEOUT_MS = 25 * 60_000;

type BuildState = { state: string; message?: string | null };

async function buildState(request: APIRequestContext): Promise<BuildState> {
  const res = await request.get(`${ORIGIN}/api/caddy-build`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { status: BuildState }).status;
}

/**
 * Done once the agent reports the binary it asked for, or a failure. The status alone can still
 * read as the previous build's "applied" for a moment after a new one is triggered.
 */
async function waitForBuild(request: APIRequestContext) {
  const settled = async () => {
    const state = (await buildState(request)).state;
    if (state === 'failed') return 'failed';
    const modules = await (await request.get(`${ORIGIN}/api/v1/caddy/modules`)).json();
    return state !== 'pending' && state !== 'building' && !modules.diff.needsRebuild
      ? 'done'
      : 'waiting';
  };
  await expect
    .poll(settled, { timeout: BUILD_TIMEOUT_MS, intervals: [10_000] })
    .not.toBe('waiting');
  const final = await buildState(request);
  expect(final.state, final.message ?? '').not.toBe('failed');
}

function caddyModules(): string {
  return execFileSync('docker', ['exec', 'caddy-proxy-manager-caddy', 'caddy', 'list-modules'], {
    encoding: 'utf8',
  });
}

async function statuses(count: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await httpGet(DOMAIN, `/?n=${i}`)).status);
  return out;
}

/** The API's way, for setup and cleanup. The save alone starts the build, as in Settings. */
async function setModuleByApi(request: APIRequestContext, include: boolean) {
  // A build still running would land after this and undo it.
  await expect
    .poll(async () => (await buildState(request)).state, {
      timeout: BUILD_TIMEOUT_MS,
      intervals: [5_000],
    })
    .not.toMatch(/^(pending|building)$/);
  const put = await request.put(`${ORIGIN}/api/v1/caddy/modules`, {
    headers: { Origin: ORIGIN },
    data: { modules: { 'caddy-ratelimit': include } },
  });
  expect(put.ok(), await put.text()).toBe(true);
  if (!(await put.json()).diff.needsRebuild) return;
  await waitForBuild(request);
}

async function selectInSettings(page: Page, include: boolean) {
  await page.goto('/settings/caddy-build');
  await waitForHydration(page);
  const module = page
    .getByRole('switch', { name: /rate limit/i })
    .or(page.getByRole('checkbox', { name: /rate limit/i }))
    .first();
  await module.scrollIntoViewIfNeeded();
  if ((await module.isChecked()) !== include) await module.click();
  await page.getByTestId('settings-page-save').click({ force: true, timeout: 15_000 });
  await expect(
    page.getByText(/caddy module selection saved\. the agent is rebuilding caddy/i),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe
  .serial('Caddy rebuild by the agent', () => {
    test.setTimeout(BUILD_TIMEOUT_MS + 5 * 60_000);
    let hostId: string | undefined;

    test.beforeAll(async ({ request }) => {
      test.setTimeout(BUILD_TIMEOUT_MS + 5 * 60_000);
      // Whatever an earlier run left: the shipped module set, in the binary too.
      await setModuleByApi(request, false);
      const created = await request.post(`${ORIGIN}/api/v1/proxy-hosts`, {
        headers: { Origin: ORIGIN },
        data: {
          name: 'Rate limited',
          domains: [DOMAIN],
          upstreams: ['echo-server:8080'],
          sslForced: false,
          rateLimit: {
            enabled: true,
            zones: [{ paths: [], maxEvents: 3, window: '1m', key: 'ip' }],
          },
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      hostId = (await created.json()).uuid;
      await waitForStatus(DOMAIN, 200, 20_000);
    });

    test.afterAll(async ({ request }) => {
      test.setTimeout(BUILD_TIMEOUT_MS + 5 * 60_000);
      // The module cannot be taken out while a host uses it.
      if (hostId !== undefined) {
        await request.delete(`${ORIGIN}/api/v1/proxy-hosts/${hostId}`, {
          headers: { Origin: ORIGIN },
        });
      }
      await setModuleByApi(request, false);
    });

    test('without the module the host is not limited', async () => {
      expect(caddyModules()).not.toContain('http.handlers.rate_limit');
      expect(await statuses(6)).toEqual([200, 200, 200, 200, 200, 200]);
    });

    test('selecting it in Settings has the agent compile it into Caddy', async ({
      page,
      request,
    }) => {
      // The saved module set is desired state, so the agent starts building with no further click.
      await selectInSettings(page, true);
      await waitForBuild(request);
      expect(caddyModules()).toContain('http.handlers.rate_limit');
    });

    test('the same host is now limited', async () => {
      await expect
        .poll(async () => (await statuses(5)).includes(429), {
          timeout: 60_000,
          intervals: [5_000],
        })
        .toBe(true);
    });
  });
