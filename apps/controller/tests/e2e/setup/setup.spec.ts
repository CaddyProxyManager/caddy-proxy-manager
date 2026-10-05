/**
 * First-run setup against `web-setup` (:3004), which has an empty database and no ADMIN_USERNAME.
 * One page for the whole block: setup is one session, and a fresh context per test would sign the
 * operator out between steps. Integration tests cover the state machine; this covers navigation.
 */
import { type Page, expect, test } from '@playwright/test';
import { waitForHydration } from '../../helpers/hydration';
import { signInWithCredentials } from '../../helpers/sign-in';

const SETUP_ORIGIN = 'http://localhost:3004';
const USERNAME = 'setupadmin';
const PASSWORD = 'SetupPassword2026!';

let page: Page;

/** By name: FormRow labels are divs, not `<label for>`. */
function field(name: string) {
  return page.locator(`input[name="${name}"]`);
}

test.beforeAll(async ({ browser }) => {
  // The suite's default storage state belongs to the other instance.
  const context = await browser.newContext({
    baseURL: SETUP_ORIGIN,
    storageState: { cookies: [], origins: [] },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page.context().close();
});

test.describe.configure({ mode: 'serial' });

test.describe('First-run setup', () => {
  test('an unconfigured instance sends every page to the setup screen', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'Set up Caddy Proxy Manager' })).toBeVisible();
  });

  test('the login page redirects into setup rather than offering a form nothing can answer', async () => {
    // /login is public, so it must still hit the setup check.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/setup$/);
  });

  test('choosing the agent role explains that agents are set up elsewhere', async () => {
    await page.goto('/setup');
    // A click or fill that lands before hydration is lost.
    await waitForHydration(page);
    await page.getByRole('radio', { name: 'Agent' }).click();

    await expect(page.getByText('Agents are set up separately')).toBeVisible();
    await page.getByRole('button', { name: 'Back to controller setup' }).click();
    await expect(page.getByRole('button', { name: /create account and sign in/i })).toBeVisible();
  });

  test('the OAuth option offers a provider form instead of an account form', async () => {
    await page.goto('/setup');
    await waitForHydration(page);
    await page.getByRole('radio', { name: 'OAuth provider' }).click();

    await expect(field('issuer')).toBeVisible();
    await expect(field('clientId')).toBeVisible();
    await expect(field('username')).toHaveCount(0);
  });

  test('a mismatched confirmation is refused without creating anything', async () => {
    await page.goto('/setup');
    await waitForHydration(page);
    await field('username').fill(USERNAME);
    await field('password').fill(PASSWORD);
    await field('passwordConfirmation').fill('SomethingElse2026!');
    await page.getByRole('button', { name: /create account and sign in/i }).click();

    await expect(page.getByText('The two passwords do not match.')).toBeVisible();
    await expect(page).toHaveURL(/\/setup$/);
  });

  test('creating the first administrator sends them to prove the password works', async () => {
    await page.goto('/setup');
    await waitForHydration(page);
    await field('username').fill(USERNAME);
    await field('password').fill(PASSWORD);
    await field('passwordConfirmation').fill(PASSWORD);
    await page.getByRole('button', { name: /create account and sign in/i }).click();

    // Login on purpose: prove the credentials before more configuration is entered.
    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 });
  });

  test('signing in with the new account carries on into the settings step', async () => {
    await page.goto('/login');
    await waitForHydration(page);
    // Identifier first: the password field stays hidden until Continue.
    await signInWithCredentials(page, USERNAME, PASSWORD);

    await expect(page).toHaveURL(/\/setup\/settings$/, { timeout: 30_000 });
  });

  test('the settings step shows the values it is about to take over', async () => {
    // The operator must see what is copied into the database before deleting it from .env.
    await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Public URL' })).toHaveValue(SETUP_ORIGIN);
  });

  test('the defaults a first certificate needs are asked for here, not afterwards', async () => {
    // Asked before the first certificate is issued, or expiry warnings have nobody to go to.
    await expect(page.getByRole('textbox', { name: 'ACME contact email' })).toBeVisible();

    // Required, so prefilled: an empty required field would block finishing.
    await expect(page.locator('input[name="defaultDomain"]')).toHaveValue(
      new URL(SETUP_ORIGIN).hostname,
    );
  });

  test('the dashboard host is a choice here, and opens off without a usable name', async () => {
    // Reached at localhost with no DASHBOARD_DOMAIN, so there is no name to claim.
    const proxy = page.getByRole('switch', { name: 'Reverse proxy this dashboard' });
    await expect(proxy).not.toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Dashboard domain' })).toBeHidden();

    await proxy.click();
    await expect(page.getByRole('textbox', { name: 'Dashboard domain' })).toHaveValue('');

    // Off again so later tests finish setup without a domain.
    await proxy.click();
    await expect(page.getByRole('textbox', { name: 'Dashboard domain' })).toBeHidden();
  });

  test('an identity provider can be configured here, not only on the account step', async () => {
    // The account step asks about OAuth only when it is the only way in.
    await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Issuer URL' })).toBeVisible();

    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('');
  });

  test('a half-filled provider is refused rather than quietly skipped', async () => {
    // Skipping it silently would leave the operator believing SSO was configured.
    await page.getByRole('textbox', { name: 'Display name' }).fill('Partly');
    await page.getByRole('button', { name: 'Save and finish setup' }).click();

    await expect(page.getByText(/needs a display name, issuer URL/i)).toBeVisible();
    await expect(page).toHaveURL(/\/setup\/settings$/);

    await page.getByRole('textbox', { name: 'Display name' }).fill('');
  });

  test('the optional containers are switches, with their settings behind them', async () => {
    // An empty CLICKHOUSE_PASSWORD here makes analytics infer off.
    const analytics = page.getByRole('switch', { name: 'Enable analytics' });
    await expect(analytics).toBeVisible();
    await expect(analytics).not.toBeChecked();
    await expect(page.getByRole('textbox', { name: 'ClickHouse URL' })).toBeHidden();

    await analytics.click();
    await expect(page.getByRole('textbox', { name: 'ClickHouse URL' })).toBeVisible();

    await expect(page.getByRole('switch', { name: 'Enable GeoIP' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'MaxMind account ID' })).toBeHidden();
  });

  test('enabling analytics without a password is refused rather than half-applied', async () => {
    // ClickHouse will not start without one, so analytics would be on with nothing recording.
    await expect(page.getByRole('switch', { name: 'Enable analytics' })).toBeChecked();
    await page.getByRole('button', { name: 'Save and finish setup' }).click();

    await expect(page.getByText(/needs a ClickHouse password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/setup\/settings$/);
  });

  test('switching analytics back off hides its settings and lets setup finish', async () => {
    await page.getByRole('switch', { name: 'Enable analytics' }).click();
    await expect(page.getByRole('textbox', { name: 'ClickHouse URL' })).toBeHidden();
  });

  test('saving the settings restarts the app, then opens the dashboard', async () => {
    // A real container restart happens here.
    test.setTimeout(180_000);

    await page.getByRole('button', { name: 'Save and finish setup' }).click();
    await expect(page.getByRole('heading', { name: 'Restarting to finish setup' })).toBeVisible({
      timeout: 30_000,
    });

    // No dashboard domain was claimed, so it comes back on the same origin.
    await expect(page).toHaveURL(new RegExp(`^${SETUP_ORIGIN}/?$`), { timeout: 180_000 });
  });

  test('setup is one-way: its screens redirect away once finished', async () => {
    await page.goto('/setup');
    await expect(page).not.toHaveURL(/\/setup$/);

    await page.goto('/setup/migrate');
    await expect(page).not.toHaveURL(/\/setup\/migrate$/);
  });

  test('the account it created can sign in from scratch', async ({ browser }) => {
    // A fresh context, so this proves the credentials rather than the setup session.
    const context = await browser.newContext({
      baseURL: SETUP_ORIGIN,
      storageState: { cookies: [], origins: [] },
    });
    const fresh = await context.newPage();
    try {
      await fresh.goto('/login');
      await waitForHydration(fresh);
      await signInWithCredentials(fresh, USERNAME, PASSWORD);

      await expect(fresh).toHaveURL(new RegExp(`^${SETUP_ORIGIN}/?$`), { timeout: 30_000 });
    } finally {
      await context.close();
    }
  });
});
