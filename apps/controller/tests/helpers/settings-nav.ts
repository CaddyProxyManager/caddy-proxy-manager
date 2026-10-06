/**
 * Opening a section of the settings page. The retry is kept although the items are real links:
 * it costs nothing, and covers the rail re-rendering under the pointer.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { waitForHydration } from './hydration';

// By test id: at mobile width the app shell adds a second navigation landmark, so
// '[role="navigation"]' would find the menu bar instead of the rail.
export const SETTINGS_SIDEBAR = '[data-testid="settings-rail"]';

/**
 * Click a settings section and wait on its level-1 heading, which cannot render while the click
 * is unhandled. `expectHeading` is for the two sections whose heading is not their nav label.
 */
export async function goToSettingsSection(
  page: Page,
  sectionName: string,
  options: { expectHeading?: string } = {},
): Promise<void> {
  // `/settings` is the tile overview and has no sidebar.
  await page.goto('/settings/general');
  await clickSettingsSection(page, sectionName, options);
}

/**
 * The save bar's button, present only while something is unsaved. By test id because some cards
 * (Dashboard Host, Email) keep a Save of their own.
 */
export function pageSave(page: Page) {
  return page.getByTestId('settings-page-save');
}

/**
 * Waits for the bar first: a field filled before hydration has nothing watching it, so the bar
 * never appears - better a clear failure about the bar than a timeout on a click.
 */
export async function savePage(page: Page, timeout = 15_000): Promise<void> {
  const save = pageSave(page);
  await expect(save).toBeVisible({ timeout });
  // Forced: the bar is sticky, so Playwright's own scroll-into-view moves it and it never reads
  // as "stable". It has just been asserted visible, which is the check that matters here.
  await save.click({ force: true });
}

/**
 * Fill and save as one retried unit: hydration can reset a field filled too early, taking the
 * save bar away, so retrying the fill alone finds the save already gone.
 */
export async function saveSetting(page: Page, field: Locator, value: string): Promise<void> {
  await expect(async () => {
    await field.fill(value);
    await expect(field).toHaveValue(value, { timeout: 2_000 });
    const save = pageSave(page);
    await expect(save).toBeVisible({ timeout: 2_000 });
    await save.click({ force: true });
  }).toPass({ timeout: 30_000 });
}

/**
 * The page each setting lives on. Written out rather than imported: a test reading the registry
 * it checks would agree with it however it changed.
 */
const SETTING_PAGES: Record<string, string> = {
  'ACME server': 'General',
  Updates: 'General',
  Branding: 'General',
  'User avatars': 'General',
  'Default response': 'Responses',
  'Error pages': 'Responses',
  'DNS providers': 'DNS',
  'DNS resolvers': 'DNS',
  'Upstream DNS pinning': 'DNS',
  'Trusted proxies': 'Network',
  Tailscale: 'Network',
  'OAuth providers': 'Authentication',
  'Directories (LDAP)': 'Authentication',
  'Password policy': 'Authentication',
  'Sign-in': 'Authentication',
  'Authentik defaults': 'Forward auth',
  'Forward auth defaults': 'Forward auth',
  'GeoIP databases': 'Geo-blocking',
  'Global geoblocking': 'Geo-blocking',
  Analytics: 'Observability',
  'Metrics & monitoring': 'Observability',
  'Access logging': 'Observability',
};

/** Open whatever page a setting is on, and wait for the setting itself. */
export async function goToSetting(page: Page, name: string): Promise<void> {
  const pageName = SETTING_PAGES[name] ?? name;
  await goToSettingsSection(page, pageName);
  // The rail click re-fetches the page; an edit made before that lands is reset with the form,
  // and a late response for the page it left can switch the view back to it.
  await page.waitForLoadState('networkidle');
  if (pageName === name) return;
  const heading = page.getByRole('heading', { level: 2, name, exact: true });
  await expect(heading).toBeVisible({ timeout: 10_000 });
  await heading.scrollIntoViewIfNeeded();
}

/** The same, for a page already on /settings, where navigating would lose the test's work. */
export async function clickSettingsSection(
  page: Page,
  sectionName: string,
  options: { expectHeading?: string } = {},
): Promise<void> {
  await waitForHydration(page);
  const sidebar = page.locator(SETTINGS_SIDEBAR);
  const navButton = sidebar.getByRole('link', { name: sectionName, exact: true });
  await expect(navButton).toBeVisible({ timeout: 10_000 });

  const heading = options.expectHeading
    ? page.getByRole('heading', { name: options.expectHeading })
    : page.getByRole('heading', { level: 1, name: sectionName });

  await expect(async () => {
    await navButton.click();
    await expect(heading).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // Again after the navigation: the page that matters is the one that just arrived.
  await waitForHydration(page);
}
