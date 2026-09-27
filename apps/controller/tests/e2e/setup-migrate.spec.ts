/**
 * Against `web-migrate` (port 3005): empty PostgreSQL plus a real pre-3.0 SQLite file built from
 * `drizzle/legacy-sqlite`. One page for the block, since a fresh context would sign out between
 * steps. The importer has integration tests; this proves the operator's path through it.
 */
import { type Page, expect, test } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';
import { signInWithCredentials } from '../helpers/sign-in';
import {
  LEGACY_CONTAINER_PATH,
  LEGACY_FIXTURE,
  buildLegacyDatabase,
  removeLegacyDatabase,
} from '../helpers/legacy-db';

const MIGRATE_ORIGIN = 'http://localhost:3005';
const LEGACY_PASSWORD = 'LegacyPassword2026!';

let page: Page;

test.beforeAll(async ({ browser }) => {
  // Spawned rather than imported: Playwright runs this file under Node, which cannot load
  // bun:sqlite. See tests/helpers/build-legacy-db.ts.
  buildLegacyDatabase(LEGACY_PASSWORD);

  const context = await browser.newContext({
    baseURL: MIGRATE_ORIGIN,
    storageState: { cookies: [], origins: [] },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page.context().close();
  removeLegacyDatabase();
});

test.describe.configure({ mode: 'serial' });

test.describe('Migrating an existing installation', () => {
  test('an unconfigured instance with an old database is offered the migration first', async () => {
    // Before account creation, not after: an operator with an old database wants its accounts, not
    // a new one alongside them.
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup\/migrate$/);
    await expect(
      page.getByRole('heading', { name: 'Migrate an existing installation' }),
    ).toBeVisible();
  });

  test('the database it found is named, so an operator can tell which one it is', async () => {
    await expect(page.getByText(LEGACY_CONTAINER_PATH)).toBeVisible();
  });

  test('a path the scan did not offer is refused, not opened', async () => {
    // Unauthenticated and names a host file, so the guard must be "a file this host offered":
    // otherwise any path is an existence check, and a planted SQLite file an account import.
    for (const path of ['/etc/passwd', '/etc/hostname', '../../etc/passwd', '/nonexistent.db']) {
      const response = await page.request.post('/api/setup/migrate', {
        data: { path, groups: ['users'] },
      });
      expect(response.status()).toBe(400);
      expect(await response.text()).toContain('not one of the databases found on this host');
    }
  });

  test('what comes across is a choice, and leaving the accounts out says so', async () => {
    // The default is everything, so an operator who reads none of this gets the migration they
    // would have got before there was anything to choose.
    const users = page.getByRole('checkbox', { name: /Users and their sign-in/ });
    await expect(users).toBeChecked();

    await users.uncheck();
    await expect(page.getByText('No accounts will be brought across')).toBeVisible();

    // Put it back: the rest of this file is the whole-database migration.
    await users.check();
    await expect(page.getByText('No accounts will be brought across')).toHaveCount(0);
  });

  test('the access lists a proxy host depends on cannot be left behind', async () => {
    // Both references are nullable, so an import without them would succeed and quietly publish a
    // host that used to sit behind a password. The checkbox says why it is locked instead.
    await expect(page.getByRole('checkbox', { name: /^Access lists/ })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /^Certificates/ })).toBeDisabled();
  });

  test('the confirmation says what is coming across before anything is copied', async () => {
    // Counts are restated before a one-way import. Cancel leaves the page for the test below.
    await page.getByRole('button', { name: 'Migrate this database' }).click();
    const sheet = page.getByRole('dialog');

    await expect(sheet.getByText(LEGACY_CONTAINER_PATH)).toBeVisible();
    // Every group is ticked by the time this runs, so the summary accounts for all of them and
    // the warning about having no account afterwards has nothing to warn about.
    await expect(sheet.getByText(/8 groups/)).toBeVisible();
    await expect(
      sheet.getByText('This instance will still need its first administrator'),
    ).toHaveCount(0);

    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toBeHidden();
  });

  test('migrating restarts the app before handing them on', async () => {
    // The restart is the point: the process read its config from the empty database at boot, and
    // signing in before it restarts means signing in to the old answers.
    await page.getByRole('button', { name: 'Migrate this database' }).click();

    // The button opens a confirmation rather than importing: the copy is one-way, so the
    // selection above gets one last look before it stops being reversible.
    await expect(page.getByRole('heading', { name: 'Migrate this database?' })).toBeVisible();
    await page.getByRole('button', { name: 'Start the migration' }).click();

    // The importer copies thirty tables; the dialog is the signal it finished.
    await expect(
      page.getByRole('heading', { name: 'Restarting to finish the migration' }),
    ).toBeVisible({ timeout: 60_000 });

    // Container down, container up, then the next step. Generous: this is a real restart of a
    // real container, and the compose healthcheck alone allows 20s of start period.
    await expect(page).toHaveURL(/\/login$/, { timeout: 180_000 });
  });

  test('the migrated administrator can sign in with their old password', async () => {
    // The whole point of migrating rather than starting fresh. A user row without its credential
    // account row would leave this account existing and unusable.
    await page.goto('/login');
    // The container restarted moments ago, so this is the coldest /login in the suite - the widest
    // window between the form being painted and React attaching its onSubmit.
    await waitForHydration(page);
    // Identifier first: the password field stays hidden until Continue.
    await signInWithCredentials(page, LEGACY_FIXTURE.adminUsername, LEGACY_PASSWORD);

    // Into the settings step: migrating brings the data across, but the deployment is not
    // configured until that step is saved.
    await expect(page).toHaveURL(/\/setup\/settings$/, { timeout: 30_000 });
  });

  test('a migrated host on the dashboard domain is offered as the dashboard host', async () => {
    // The old host was very likely how this dashboard was reached before. The dashboard host wins
    // the tie for its exact domain, so the old one would stop answering without being told.
    await page.getByRole('switch', { name: 'Reverse proxy this dashboard' }).click();
    const domain = page.getByRole('textbox', { name: 'Dashboard domain' });
    await domain.fill('unrelated.example.com');
    await expect(page.getByText(/already serves/)).toHaveCount(0);

    await domain.fill(LEGACY_FIXTURE.proxyHostDomain.toUpperCase());
    await expect(
      page.getByText(
        `${LEGACY_FIXTURE.proxyHostName} already serves ${LEGACY_FIXTURE.proxyHostDomain}`,
      ),
    ).toBeVisible();
    // On by default, and it says what it will do to the old host.
    await expect(
      page.getByRole('switch', { name: `Copy the settings from ${LEGACY_FIXTURE.proxyHostName}` }),
    ).toBeChecked();
    await expect(page.getByText(/then disables legacy-app/)).toBeVisible();
  });

  test('finishing setup restarts again and ends on the summary a migrated deployment is owed', async () => {
    // Past the file's 60s default, and wider than the first restart's: this one can spend up to a
    // minute waiting out the cooldown the migration's restart left behind.
    test.setTimeout(300_000);

    // Not the dashboard: an operator who just replaced their database is first told where the old
    // one is and what to drop from .env. Despite the dashboard host, this session keeps it here.
    await page.getByRole('button', { name: 'Save and finish setup' }).click();
    await expect(page.getByRole('heading', { name: 'Restarting to finish setup' })).toBeVisible({
      timeout: 30_000,
    });

    // The second restart, and the one the route's one-a-minute cooldown can land on; the screen
    // waits it out rather than reporting it.
    await expect(page).toHaveURL(/\/setup\/done$/, { timeout: 240_000 });
    await expect(page.getByRole('heading', { name: 'Migration complete' })).toBeVisible();
    await expect(page.getByRole('link', { name: /download the old database/i })).toBeVisible();
  });

  test('the proxy hosts it had are there', async () => {
    await page.goto('/proxy-hosts');
    await expect(
      page.getByRole('table').getByText(LEGACY_FIXTURE.proxyHostName, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('the dashboard host took over the domain and the host it was copied from', async () => {
    await page.goto('/settings/dashboard');
    await expect(page.getByRole('textbox', { name: 'Dashboard domain' })).toHaveValue(
      LEGACY_FIXTURE.proxyHostDomain,
      { timeout: 15_000 },
    );
    // The legacy host forced HTTPS, and browsers that visited it are pinned to it.
    await expect(page.getByRole('switch', { name: 'Serve it over HTTPS' })).toBeChecked();
    await expect(page.getByText('Proxy options')).toBeVisible();

    // Its only domain is the dashboard's now, so it is paused rather than left looking live.
    await page.goto('/proxy-hosts?state=disabled');
    await expect(
      page.getByRole('table').getByText(LEGACY_FIXTURE.proxyHostName, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('the settings it had came across too', async () => {
    await page.goto('/settings/general');
    // Named `defaultDomain` now; the legacy database still holds `primaryDomain`, so this is
    // also the assertion that the read fallback in getGeneralSettings works.
    await expect(page.locator('input[name="defaultDomain"]')).toHaveValue(
      LEGACY_FIXTURE.primaryDomain,
      { timeout: 15_000 },
    );
  });

  test('the old database is still offered for download afterwards', async () => {
    // It was read, not moved. An operator who has just replaced their database wants a copy of the
    // one they came from before they delete anything.
    const response = await page.request.get('/api/setup/backup');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-disposition']).toContain('caddy-proxy-manager.db');
  });

  test('the migration offer does not come back', async () => {
    await page.goto('/setup/migrate');
    await expect(page).not.toHaveURL(/\/setup\/migrate$/);
  });
});
