/**
 * Admin notifications against the real stack, delivered to mailpit: the Notifications block's
 * switches, an account auto-disabled after failed sign-ins (re-enabled on Users, then by
 * `cpm-server --enable-user`), agent-remote going offline and coming back, and a host whose
 * upstream is dead. Short thresholds are set through Settings and restored afterwards.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as seed from '../helpers/seed';
import { waitForHydration } from '../helpers/hydration';
import { httpGet, waitForStatus } from '../helpers/http';
import { SMTP_SETTING_KEYS, configureSmtp, deleteAllMail, removeSmtp } from '../helpers/mailpit';
import { goToSetting, pageSave } from '../helpers/settings-nav';

const BASE = 'http://localhost:3000';
const MAILPIT = 'http://localhost:8025/api/v1';
const RECIPIENT = 'notify-e2e@example.com';
const USER = { username: `notify-${Date.now()}`, password: 'NotifyE2ePassword2026!' };
const USER_EMAIL = `${USER.username}@localhost`;
const WEB = 'caddy-proxy-manager-web';
const REMOTE = 'caddy-proxy-manager-agent-remote';
const DEAD_DOMAIN = 'notify-upstream.test';

const OFFLINE_MINUTES = 'Agent offline after (minutes)';
const ERROR_COUNT = 'Upstream errors before telling (responses)';
const ERROR_MINUTES = 'Upstream error window (minutes)';
const DISABLE_SWITCH = 'Disable accounts after repeated failed sign-ins';
const DISABLE_AFTER = 'Failed sign-ins before an account is disabled';

/** Registry rows this spec writes through the forms, removed once they are back to defaults. */
const TOUCHED_KEYS = [
  'config:email_alert_recipients',
  'config:notify_agent_offline_minutes',
  'config:notify_upstream_error_count',
  'config:notify_upstream_error_minutes',
  'config:notify_update_available',
  'config:account_lock_disable_enabled',
  'config:account_lock_disable_after',
];

test.describe.configure({ mode: 'serial' });

/**
 * A message to RECIPIENT whose text holds `needle`. By text, not subject: whatever else happened
 * in the same minute shares the email, and its subject then only counts them.
 */
async function waitForNotification(needle: string, timeoutMs: number): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        const res = await fetch(
          `${MAILPIT}/search?query=${encodeURIComponent(`to:"${RECIPIENT}"`)}`,
        );
        if (!res.ok) return false;
        const { messages } = (await res.json()) as { messages: { ID: string }[] };
        for (const { ID } of messages) {
          const message = (await (await fetch(`${MAILPIT}/message/${ID}`)).json()) as {
            Text: string;
          };
          if (message.Text.includes(needle)) {
            found = message.Text;
            return true;
          }
        }
        return false;
      },
      { timeout: timeoutMs, intervals: [3_000] },
    )
    .toBe(true);
  return found;
}

async function signInStatus(browser: Browser, password: string): Promise<number> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await ctx.request.post(`${BASE}/api/auth/sign-in/username`, {
      headers: { Origin: BASE },
      data: { username: USER.username, password },
    });
    return res.status();
  } finally {
    await ctx.close();
  }
}

async function failSignIns(browser: Browser, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    expect(await signInStatus(browser, 'WrongPassword2026!')).toBe(401);
  }
}

async function openNotifications(page: Page): Promise<void> {
  await page.goto('/settings/email');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
}

/** One form at a time, so the message waited for is the one that form answers with. */
async function saveAndConfirm(page: Page, message: RegExp): Promise<void> {
  // Nothing to save when the form already held these values, as a restore often does.
  const dirty = await pageSave(page)
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!dirty) return;
  await pageSave(page).click({ force: true });
  await expect(page.getByRole('status').filter({ hasText: message }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function setNotificationFields(page: Page, values: Record<string, string>): Promise<void> {
  await openNotifications(page);
  for (const [label, value] of Object.entries(values)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await saveAndConfirm(page, /settings saved/i);
}

async function setRecipients(page: Page, value: string): Promise<void> {
  await openNotifications(page);
  await page.getByRole('textbox', { name: /^recipients/i }).fill(value);
  await saveAndConfirm(page, /email settings saved/i);
}

async function setAutoDisable(page: Page, on: boolean, after: string): Promise<void> {
  await goToSetting(page, 'Sign-in');
  const toggle = page.getByRole('switch', { name: new RegExp(`^${DISABLE_SWITCH}`) });
  if ((await toggle.isChecked()) !== on) await toggle.click();
  await page.getByLabel(DISABLE_AFTER, { exact: true }).fill(after);
  await saveAndConfirm(page, /settings saved/i);
}

// ── agent-remote, as tests/e2e/agents.spec.ts pairs it ──────────────────────

type GqlAgent = { id: number; name: string; connected: boolean };

async function agents(page: Page): Promise<GqlAgent[]> {
  const res = await page.request.post('/api/graphql', {
    headers: { Origin: BASE },
    data: { query: '{ agents { id name connected } }' },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { data: { agents: GqlAgent[] } }).data.agents;
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
}

async function openAgentSettings(page: Page) {
  await page.goto('/settings/agent');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { name: 'Pair an agent' })).toBeVisible();
}

async function unpairRemote(page: Page, bundledId: number): Promise<void> {
  const list = await agents(page);
  const index = list.findIndex((agent) => agent.id !== bundledId);
  if (index < 0) return;
  await openAgentSettings(page);
  await page
    .getByRole('button', { name: /^unpair$/i })
    .nth(index)
    .click();
  await expect.poll(async () => (await agents(page)).length).toBe(1);
}

test.describe('Admin notifications', () => {
  let bundledId = 0;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    await deleteAllMail();
    seed.ensureTestUser(USER.username, USER.password, 'user');
    const page = await (await browser.newContext()).newPage();
    bundledId = (await agents(page)).find((agent) => agent.connected)!.id;
    await configureSmtp(page);
    await setRecipients(page, RECIPIENT);
    await setNotificationFields(page, {
      [OFFLINE_MINUTES]: '1',
      [ERROR_COUNT]: '3',
      [ERROR_MINUTES]: '5',
    });
    await page.context().close();
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await (await browser.newContext()).newPage();
    try {
      docker('start', REMOTE);
    } catch {
      // Already running.
    }
    await unpairRemote(page, bundledId);
    await setAutoDisable(page, false, '10');
    await setNotificationFields(page, {
      [OFFLINE_MINUTES]: '5',
      [ERROR_COUNT]: '10',
      [ERROR_MINUTES]: '5',
    });
    await setRecipients(page, '');
    await removeSmtp(page);
    await page.context().close();
    for (const key of [...TOUCHED_KEYS, ...SMTP_SETTING_KEYS]) seed.clearSettingRow(key);
    seed.deleteUserByEmail(USER_EMAIL);
  });

  test('the Notifications block keeps a switch as saved', async ({ page }) => {
    await openNotifications(page);
    await expect(page.getByLabel(OFFLINE_MINUTES, { exact: true })).toHaveValue('1');
    // The label renders twice inside the switch, so its name repeats it.
    const release = page.getByRole('switch', { name: /^New release/ });
    await expect(release).toBeChecked();
    await release.click();
    await saveAndConfirm(page, /settings saved/i);

    await openNotifications(page);
    await expect(page.getByRole('switch', { name: /^New release/ })).not.toBeChecked();
    await page.getByRole('switch', { name: /^New release/ }).click();
    await saveAndConfirm(page, /settings saved/i);
    await openNotifications(page);
    await expect(page.getByRole('switch', { name: /^New release/ })).toBeChecked();
  });

  test('an account disabled by failed sign-ins is reported, and re-enabled on Users', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await setAutoDisable(page, true, '3');
    await deleteAllMail();

    await failSignIns(browser, 3);
    const text = await waitForNotification(`${USER_EMAIL} was disabled after 3 failed`, 180_000);
    expect(text).toContain('cpm-server --enable-user');
    // Its own password no longer works, and says nothing about why.
    expect(await signInStatus(browser, USER.password)).toBe(401);

    await page.goto('/users');
    await waitForHydration(page);
    await page.getByPlaceholder('Search users…').fill(USER.username);
    await page
      .getByRole('navigation', { name: 'Users' })
      .getByRole('listitem')
      .filter({ hasText: USER_EMAIL })
      .click();
    await expect(
      page.getByText(/disabled automatically after too many failed sign-ins/i),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Enable user / }).click();
    await expect(page.getByRole('button', { name: /^Disable user / })).toBeVisible({
      timeout: 15_000,
    });

    await expect.poll(() => signInStatus(browser, USER.password)).toBe(200);
  });

  test('cpm-server --enable-user enables it from the console', async ({ browser }) => {
    test.setTimeout(120_000);
    // Its count started over when it was enabled, so three more failures disable it again.
    await failSignIns(browser, 3);
    await expect.poll(() => signInStatus(browser, USER.password)).toBe(401);

    const output = docker('exec', WEB, '/app/cpm-server', '--enable-user', USER.username);
    expect(output).toContain(`Enabled ${USER_EMAIL}`);
    expect(await signInStatus(browser, USER.password)).toBe(200);
  });

  test('an agent gone past the threshold is reported, and again when it is back', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await openAgentSettings(page);
    await page.getByRole('button', { name: /generate a pairing code/i }).click();
    const code = (
      await page
        .getByText(/^[A-Z]{6}$/)
        .first()
        .innerText()
    ).trim();
    docker(
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
      '--yes',
    );
    await expect
      .poll(async () => (await agents(page)).find((a) => a.id !== bundledId)?.connected ?? false, {
        timeout: 60_000,
      })
      .toBe(true);
    const remote = (await agents(page)).find((a) => a.id !== bundledId)!;
    // Long enough for its first status report, which is what "had connected" is read from.
    await page.waitForTimeout(5_000);
    await deleteAllMail();

    docker('stop', REMOTE);
    await waitForNotification(
      `The agent ${remote.name} has been disconnected for more than 1 minute`,
      300_000,
    );

    docker('start', REMOTE);
    await expect
      .poll(async () => (await agents(page)).find((a) => a.id === remote.id)?.connected ?? false, {
        timeout: 120_000,
        intervals: [2_000],
      })
      .toBe(true);
    await waitForNotification(`The agent ${remote.name} is connected again.`, 180_000);
    await unpairRemote(page, bundledId);
  });

  test('a host whose upstream is dead is reported from the access log', async ({ page }) => {
    test.setTimeout(300_000);
    const LOGGING = `${BASE}/api/v1/settings/logging`;
    const previousLogging = await (await page.request.get(LOGGING)).json();
    let hostId: number | undefined;
    try {
      const logging = await page.request.put(LOGGING, {
        headers: { Origin: BASE },
        data: { enabled: true, format: 'json' },
      });
      expect(logging.ok(), await logging.text()).toBeTruthy();

      const created = await page.request.post(`${BASE}/api/v1/proxy-hosts`, {
        headers: { Origin: BASE },
        data: {
          name: 'Notify upstream',
          domains: [DEAD_DOMAIN],
          // Nothing listens there, so Caddy answers 502.
          upstreams: ['127.0.0.1:1'],
          sslForced: false,
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      hostId = (await created.json()).id;
      await waitForStatus(DEAD_DOMAIN, 502, 30_000);
      await deleteAllMail();

      for (let i = 0; i < 5; i++) expect((await httpGet(DEAD_DOMAIN, `/${i}`)).status).toBe(502);
      const text = await waitForNotification(
        `${DEAD_DOMAIN} answered`,
        // The agent reads the log every 30s, then the batch waits a minute.
        240_000,
      );
      expect(text).toMatch(/with 502, 503 or 504 within 5 minutes/);
    } finally {
      await page.request.put(LOGGING, { headers: { Origin: BASE }, data: previousLogging });
      if (hostId !== undefined) {
        await page.request.delete(`${BASE}/api/v1/proxy-hosts/${hostId}`, {
          headers: { Origin: BASE },
        });
      }
    }
  });
});
