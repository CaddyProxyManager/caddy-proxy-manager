import { test, expect, type Page } from '@playwright/test';
import { clickSettingsSection, goToSetting, savePage } from '../helpers/settings-nav';
import { applyStagedChanges, expectStaged } from '../helpers/staged-settings';

const EMPTY_GEOBLOCK = {
  enabled: false,
  block_countries: [],
  block_continents: [],
  block_asns: [],
  block_cidrs: [],
  block_ips: [],
  allow_countries: [],
  allow_continents: [],
  allow_asns: [],
  allow_cidrs: [],
  allow_ips: [],
  trusted_proxies: [],
  fail_closed: false,
  response_status: 403,
  response_body: 'Forbidden',
  response_headers: {},
  redirect_url: '',
};

/** Routable nowhere, so applying them to Caddy blocks no real traffic. */
const SAFE_BLOCK_CIDR = '198.51.100.0/24'; // TEST-NET-2
const SAFE_ALLOW_CIDR = '203.0.113.0/24'; // TEST-NET-3
const SAFE_BLOCK_CIDR_2 = '192.0.2.0/24'; // TEST-NET-1
const SAFE_ALLOW_CIDR_2 = '233.252.0.0/24'; // MCAST-TEST-NET

const API_GEOBLOCK = 'http://localhost:3000/api/v1/settings/geoblock';
const ORIGIN = 'http://localhost:3000';

/** Found by a field that is always mounted: the tabs unmount the rules not showing. */
function geoblockForm(page: Page) {
  return page.locator('form', { has: page.locator('[name="geoblockPresent"]') });
}

/** Find a TagInput's visible text input by its hidden input name. */
function cidrInput(
  parent: ReturnType<(typeof test)['info']> extends never ? never : any,
  name: string,
) {
  return parent.locator(`div:has(> input[name="${name}"])`).locator('input[type="text"]');
}

test.describe('Geo Blocking - form persistence', () => {
  /**
   * Needs an Origin header, or the same-origin check 403s it silently. `Connection: close`: the
   * pooled socket idles right at Node's 5s keep-alive timeout, so the next reset could hang up.
   */
  async function resetGeoblock(page: any) {
    const put = () =>
      page.request.put(API_GEOBLOCK, {
        headers: { Origin: ORIGIN, Connection: 'close' },
        data: EMPTY_GEOBLOCK,
      });
    const res = await put().catch((error: Error) => {
      if (!/socket hang up|ECONNRESET/i.test(error.message)) throw error;
      return put();
    });
    expect(res.ok(), `geoblock reset failed: ${res.status()}`).toBe(true);
  }

  test.beforeEach(async ({ page }) => {
    await resetGeoblock(page);
    await goToSetting(page, 'Global Geoblocking');
  });

  test.afterEach(async ({ page }) => {
    await resetGeoblock(page);
  });

  /**
   * Regression: Radix Tabs unmount inactive content, so only the visible tab's hidden inputs were
   * submitted - saving on "Block Rules" wiped every allow rule. Uses RFC 5737 ranges.
   */
  test('saving block rules does not wipe allow rules', async ({ page }) => {
    const geoSection = geoblockForm(page);
    const enableSwitch = geoSection.getByRole('switch', { name: 'Enable geo blocking' });
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click();
    }

    await geoSection.getByRole('button', { name: /allow rules/i }).click();
    const allowInput = cidrInput(geoSection, 'geoblockAllowCidrs');
    await allowInput.fill(SAFE_ALLOW_CIDR);
    await allowInput.press('Enter');
    await expect(geoSection.locator(`text=${SAFE_ALLOW_CIDR}`)).toBeVisible();

    await geoSection.getByRole('button', { name: /block rules/i }).click();
    const blockInput = cidrInput(geoSection, 'geoblockBlockCidrs');
    await blockInput.fill(SAFE_BLOCK_CIDR);
    await blockInput.press('Enter');
    await expect(geoSection.locator(`text=${SAFE_BLOCK_CIDR}`)).toBeVisible();

    await savePage(page);
    await expectStaged(page, 10000);

    // A UI save stages; the API reports applied values.
    await applyStagedChanges(page);

    // Before reloading, to tell a persistence bug from a stale render; the banner proves neither.
    const saved = await (await page.request.get(API_GEOBLOCK)).json();
    expect(saved, 'geoblock config was not persisted by the save').toMatchObject({
      enabled: true,
      block_cidrs: [SAFE_BLOCK_CIDR],
      allow_cidrs: [SAFE_ALLOW_CIDR],
    });

    await page.reload();
    await clickSettingsSection(page, 'Geo-blocking');
    const fresh = geoblockForm(page);

    // The tabs exist only while enabled; otherwise a lost save is an opaque tab timeout.
    await expect(fresh.getByRole('switch', { name: 'Enable geo blocking' })).toBeChecked();

    await fresh.getByRole('button', { name: /block rules/i }).click();
    await expect(fresh.locator(`text=${SAFE_BLOCK_CIDR}`)).toBeVisible({ timeout: 5000 });

    await fresh.getByRole('button', { name: /allow rules/i }).click();
    await expect(fresh.locator(`text=${SAFE_ALLOW_CIDR}`)).toBeVisible({ timeout: 5000 });
  });

  /**
   * Regression: the tag inputs call onEnter without preventing the keypress default, so adding a
   * CIDR also submitted the form - persisting a half-finished config and re-applying Caddy.
   */
  test('adding a rule with Enter does not submit the form', async ({ page }) => {
    const geoSection = geoblockForm(page);
    const enableSwitch = geoSection.getByRole('switch', { name: 'Enable geo blocking' });
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click();
    }
    await expect(enableSwitch).toBeChecked();

    await geoSection.getByRole('button', { name: /block rules/i }).click();
    const blockInput = cidrInput(geoSection, 'geoblockBlockCidrs');
    await blockInput.fill(SAFE_BLOCK_CIDR);
    await blockInput.press('Enter');

    await expect(geoSection.locator(`text=${SAFE_BLOCK_CIDR}`)).toBeVisible();

    // beforeEach reset the config, so any stored rule means Enter submitted the form.
    await page.waitForTimeout(2_000);
    const stored = await (await page.request.get(API_GEOBLOCK)).json();
    expect(stored.block_cidrs, 'pressing Enter in a tag input saved the form').toEqual([]);
    expect(stored.enabled, 'pressing Enter in a tag input saved the form').toBe(false);
  });

  test('saving allow rules does not wipe block rules', async ({ page }) => {
    const geoSection = geoblockForm(page);
    const enableSwitch = geoSection.getByRole('switch', { name: 'Enable geo blocking' });
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click();
    }

    await geoSection.getByRole('button', { name: /block rules/i }).click();
    const blockInput = cidrInput(geoSection, 'geoblockBlockCidrs');
    await blockInput.fill(SAFE_BLOCK_CIDR_2);
    await blockInput.press('Enter');
    await expect(geoSection.locator(`text=${SAFE_BLOCK_CIDR_2}`)).toBeVisible();

    await geoSection.getByRole('button', { name: /allow rules/i }).click();
    const allowInput = cidrInput(geoSection, 'geoblockAllowCidrs');
    await allowInput.fill(SAFE_ALLOW_CIDR_2);
    await allowInput.press('Enter');
    await expect(geoSection.locator(`text=${SAFE_ALLOW_CIDR_2}`)).toBeVisible();

    await savePage(page);
    await expectStaged(page, 10000);

    await page.reload();
    await clickSettingsSection(page, 'Geo-blocking');
    const fresh = geoblockForm(page);

    await fresh.getByRole('button', { name: /block rules/i }).click();
    await expect(fresh.locator(`text=${SAFE_BLOCK_CIDR_2}`)).toBeVisible({ timeout: 5000 });

    await fresh.getByRole('button', { name: /allow rules/i }).click();
    await expect(fresh.locator(`text=${SAFE_ALLOW_CIDR_2}`)).toBeVisible({ timeout: 5000 });
  });

  /**
   * Regression: Radix Accordion unmounts closed content, so advanced settings (redirect URL,
   * trusted proxies, response status/body) were wiped when saving with it collapsed.
   */
  test('advanced settings survive save when accordion is collapsed', async ({ page }) => {
    const geoSection = geoblockForm(page);
    const enableSwitch = geoSection.getByRole('switch', { name: 'Enable geo blocking' });
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click();
    }

    // Collapsible defaults to open; drive it by aria-expanded rather than assume a state.
    const advancedTrigger = geoSection
      .locator('button[aria-expanded]')
      .filter({ hasText: /trusted proxies/i });
    const setAdvancedExpanded = async (expanded: boolean) => {
      if ((await advancedTrigger.getAttribute('aria-expanded')) !== String(expanded)) {
        await advancedTrigger.click();
      }
      await expect(advancedTrigger).toHaveAttribute('aria-expanded', String(expanded));
    };

    await setAdvancedExpanded(true);
    const redirectInput = geoSection.locator('input[name="geoblockRedirectUrl"]');
    await expect(redirectInput).toBeVisible();
    await redirectInput.fill('https://example.com/blocked');

    await setAdvancedExpanded(false);
    await expect(redirectInput).toBeHidden();

    await savePage(page);
    await expectStaged(page, 10000);

    await page.reload();
    await clickSettingsSection(page, 'Geo-blocking');
    const fresh = geoblockForm(page);
    // A plain name match also picks up the "Add to Trusted Proxies" button.
    const freshTrigger = fresh
      .locator('button[aria-expanded]')
      .filter({ hasText: /trusted proxies/i });
    if ((await freshTrigger.getAttribute('aria-expanded')) !== 'true') {
      await freshTrigger.click();
    }
    await expect(fresh.locator('input[name="geoblockRedirectUrl"]')).toHaveValue(
      'https://example.com/blocked',
      { timeout: 5000 },
    );
  });

  /** Regression (#241): form state seeded from useState never re-synced with fresh props. */
  test('form reflects saved values immediately without reload', async ({ page }) => {
    const geoSection = geoblockForm(page);
    const enableSwitch = geoSection.getByRole('switch', { name: 'Enable geo blocking' });
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click();
    }

    const advancedTrigger = geoSection
      .locator('button[aria-expanded]')
      .filter({ hasText: /trusted proxies/i });
    if ((await advancedTrigger.getAttribute('aria-expanded')) !== 'true') {
      await advancedTrigger.click();
    }

    const redirectInput = geoSection.locator('input[name="geoblockRedirectUrl"]');
    await expect(redirectInput).toBeVisible();
    await redirectInput.fill('https://example.com/no-refresh');

    const statusInput = geoSection.locator('input[name="geoblockResponseStatus"]');
    await statusInput.fill('418');

    await savePage(page);
    await expectStaged(page, 10000);

    // No page.reload() here - the visible form must already reflect the save.
    await expect(geoSection.locator('input[name="geoblockRedirectUrl"]')).toHaveValue(
      'https://example.com/no-refresh',
      { timeout: 10_000 },
    );
    await expect(geoSection.locator('input[name="geoblockResponseStatus"]')).toHaveValue('418');
  });

  /** Does not save, so no Caddy config is affected. */
  test('LAN Only preset: values survive tab switching', async ({ page }) => {
    const geoSection = geoblockForm(page);
    const enableSwitch = geoSection.getByRole('switch', { name: 'Enable geo blocking' });
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click();
    }

    await geoSection.getByRole('button', { name: /lan only/i }).click();

    await expect(geoSection.locator('text=0.0.0.0/0')).toBeVisible();

    await geoSection.getByRole('button', { name: /allow rules/i }).click();
    await expect(geoSection.locator('text=10.0.0.0/8')).toBeVisible();
    await expect(geoSection.locator('text=172.16.0.0/12')).toBeVisible();
    await expect(geoSection.locator('text=192.168.0.0/16')).toBeVisible();

    await geoSection.getByRole('button', { name: /block rules/i }).click();
    await expect(geoSection.locator('text=0.0.0.0/0')).toBeVisible();

    await geoSection.getByRole('button', { name: /allow rules/i }).click();
    await expect(geoSection.locator('text=10.0.0.0/8')).toBeVisible();
  });

  /** Resets right after reading back, shortening the window where 0.0.0.0/0 blocks everything. */
  test('LAN Only preset: values persist after save', async ({ page }) => {
    const geoSection = geoblockForm(page);
    const enableSwitch = geoSection.getByRole('switch', { name: 'Enable geo blocking' });
    if (!(await enableSwitch.isChecked())) {
      await enableSwitch.click();
    }

    await geoSection.getByRole('button', { name: /lan only/i }).click();
    await savePage(page);
    await expectStaged(page, 10000);

    await applyStagedChanges(page);

    const res = await page.request.get(API_GEOBLOCK);
    await resetGeoblock(page);

    const saved = await res.json();
    expect(saved.block_cidrs).toContain('0.0.0.0/0');
    expect(saved.allow_cidrs).toContain('10.0.0.0/8');
    expect(saved.allow_cidrs).toContain('172.16.0.0/12');
    expect(saved.allow_cidrs).toContain('192.168.0.0/16');
  });
});
