/**
 * The Agents page and pairing, against real agents: the bundled one is only read and renamed (and
 * renamed back), while agent-remote, a second agent container whose Docker and Caddy lead nowhere,
 * is paired with a code from Settings, re-paired with its own code, and unpaired.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { waitForHydration } from '../helpers/hydration';

const REMOTE = 'caddy-proxy-manager-agent-remote';

function pairRemote(code: string, extra: string[] = ['--yes']): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      'docker',
      [
        'exec',
        REMOTE,
        'cpm-agent',
        '--pair',
        '--host',
        'web',
        '--port',
        '3000',
        '--code',
        code,
        ...extra,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    return { ok: true, output };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

/** The agent's own view, from its local socket. */
function remoteState(): { lifecycle: string; message: string | null } | null {
  const res = spawnSync(
    'docker',
    [
      'exec',
      REMOTE,
      'curl',
      '-s',
      '--unix-socket',
      '/data/agent.sock',
      'http://agent.local/local/state',
    ],
    { encoding: 'utf8' },
  );
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

type GqlAgent = { id: number; name: string; connected: boolean };

async function agents(page: Page): Promise<GqlAgent[]> {
  const res = await page.request.post('/api/graphql', {
    headers: { Origin: 'http://localhost:3000' },
    data: { query: '{ agents { id name connected } }' },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { data: { agents: GqlAgent[] } }).data.agents;
}

async function openAgentSettings(page: Page) {
  await page.goto('/settings/agent');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { name: 'Pair an agent' })).toBeVisible();
}

/** The remote is whichever paired agent is not the one this stack started with. */
async function remoteAgent(page: Page, bundledId: number) {
  return (await agents(page)).find((agent) => agent.id !== bundledId);
}

test.describe.configure({ mode: 'serial' });

test.describe('Agents', () => {
  test.setTimeout(120_000);
  let bundled: GqlAgent;

  test.beforeAll(async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    const list = await agents(page);
    expect(
      list.filter((agent) => agent.connected),
      'the bundled agent is connected',
    ).toHaveLength(1);
    bundled = list.find((agent) => agent.connected)!;
    await page.context().close();
  });

  test.afterAll(async ({ browser }) => {
    // A remote left paired would receive every later spec's config.
    const page = await (await browser.newContext()).newPage();
    const remote = await remoteAgent(page, bundled.id);
    if (remote) {
      await openAgentSettings(page);
      await page
        .getByRole('button', { name: /^unpair$/i })
        .nth((await agents(page)).findIndex((a) => a.id === remote.id))
        .click();
    }
    await page.context().close();
  });

  test('the Agents page shows the bundled agent, connected, and renames it', async ({ page }) => {
    await page.goto('/agents');
    await waitForHydration(page);
    await expect(page.getByText(bundled.name).first()).toBeVisible();
    await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^v\d+\.\d+\.\d+/).first()).toBeVisible();

    const renamed = `${bundled.name} (e2e)`;
    try {
      await page
        .getByRole('button', { name: /^rename$/i })
        .first()
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill(renamed);
      await dialog.getByRole('button', { name: /^rename$/i }).click();
      await expect(page.getByText(renamed).first()).toBeVisible({ timeout: 15_000 });
      expect((await agents(page)).find((a) => a.id === bundled.id)?.name).toBe(renamed);
    } finally {
      await page.goto('/agents');
      await waitForHydration(page);
      await page
        .getByRole('button', { name: /^rename$/i })
        .first()
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill(bundled.name);
      await dialog.getByRole('button', { name: /^rename$/i }).click();
      await expect
        .poll(async () => (await agents(page)).find((a) => a.id === bundled.id)?.name)
        .toBe(bundled.name);
    }
  });

  test('a wrong code is refused before anything is paired', async ({ page }) => {
    const wrong = pairRemote('ZZZZZZ');
    expect(wrong.ok).toBe(false);
    expect(wrong.output).toMatch(/code/i);
    expect(await remoteAgent(page, bundled.id)).toBeUndefined();
  });

  test('a code from Settings pairs a second agent, which connects', async ({ page }) => {
    await openAgentSettings(page);
    await page.getByRole('button', { name: /generate a pairing code/i }).click();
    const code = (
      await page
        .getByText(/^[A-Z]{6}$/)
        .first()
        .innerText()
    ).trim();
    await expect(page.getByText(/--code [A-Z]{6}/)).toContainText(code);

    // Without --yes the preview names the controller, and a missing terminal declines.
    const preview = pairRemote(code, []);
    expect(preview.ok).toBe(false);
    expect(preview.output).toMatch(/about to pair with/i);

    const paired = pairRemote(code);
    expect(paired.ok, paired.output).toBe(true);
    expect(paired.output).toContain('Paired with http://web:3000');

    await expect
      .poll(async () => (await remoteAgent(page, bundled.id))?.connected ?? false, {
        timeout: 30_000,
      })
      .toBe(true);
    // Spent: the same code does not pair twice.
    expect(pairRemote(code).ok).toBe(false);

    await page.goto('/agents');
    await waitForHydration(page);
    const remote = (await remoteAgent(page, bundled.id))!;
    await expect(page.getByText(remote.name).first()).toBeVisible();
  });

  test('re-pairing issues a code only that agent can use', async ({ page }) => {
    const remote = (await remoteAgent(page, bundled.id))!;
    await openAgentSettings(page);
    const order = (await agents(page)).findIndex((a) => a.id === remote.id);
    await page
      .getByRole('button', { name: /^re-pair$/i })
      .nth(order)
      .click();
    const box = page.getByText(`Re-pair ${remote.name}`);
    await expect(box).toBeVisible({ timeout: 15_000 });
    const code = (
      await page
        .getByText(/^[A-Z]{6}$/)
        .first()
        .innerText()
    ).trim();

    const repaired = pairRemote(code);
    expect(repaired.ok, repaired.output).toBe(true);
    await expect
      .poll(async () => (await remoteAgent(page, bundled.id))?.connected ?? false, {
        timeout: 30_000,
      })
      .toBe(true);
    expect((await agents(page)).filter((a) => a.id !== bundled.id)).toHaveLength(1);
  });

  test('unpairing drops it, and the bundled agent carries on', async ({ page }) => {
    test.setTimeout(150_000);
    const remote = (await remoteAgent(page, bundled.id))!;
    await openAgentSettings(page);
    const order = (await agents(page)).findIndex((a) => a.id === remote.id);
    await page
      .getByRole('button', { name: /^unpair$/i })
      .nth(order)
      .click();
    await expect.poll(async () => (await remoteAgent(page, bundled.id)) ?? null).toBeNull();
    const list = await agents(page);

    expect(list).toEqual([expect.objectContaining({ id: bundled.id, connected: true })]);

    // No restart: the closed stream, a refused reconnect or a 401 on its heartbeat idles it.
    await expect
      .poll(() => remoteState()?.lifecycle, { timeout: 90_000, intervals: [1_000] })
      .toBe('idle');
    expect(remoteState()?.message).toMatch(/no longer recognises this agent/i);
  });
});
