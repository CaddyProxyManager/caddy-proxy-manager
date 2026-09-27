import { test, expect, type Page } from '@playwright/test';
import { applyStagedChanges, expectStaged } from '../helpers/staged-settings';
import {
  goToSetting,
  pageSave,
  savePage,
  saveSetting,
  SETTINGS_SIDEBAR,
} from '../helpers/settings-nav';
import { waitForHydration } from '../helpers/hydration';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mutating v1 API calls are same-origin checked and 403 without this header. */
const SETTINGS_ORIGIN = 'http://localhost:3000';

/**
 * Retries the press: the shortcut binds in a useEffect, so the server-rendered control can be
 * visible before the listener exists, and a listener has no DOM to wait on.
 */
async function openPaletteWithKeyboard(page: Page) {
  await expect(page.locator(SETTINGS_SIDEBAR).getByText('Search…', { exact: true })).toBeVisible();
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

const goToSection = goToSetting;

// ─── Page load & layout ──────────────────────────────────────────────────────

test.describe('Settings - page load & layout', () => {
  test('settings page loads without redirecting to login', async ({ page }) => {
    await page.goto('/settings/general');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('settings page defaults to the General section', async ({ page }) => {
    await page.goto('/settings/general');
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  });

  test('sidebar is visible and shows all group headers', async ({ page }) => {
    await page.goto('/settings/general');
    const sidebar = page.locator(SETTINGS_SIDEBAR);
    await expect(sidebar).toBeVisible();
    for (const group of ['System', 'Networking', 'Security', 'Observability']) {
      // By role: `Observability` names a group and a page inside it, and text matches both.
      await expect(sidebar.getByRole('group', { name: group })).toBeVisible();
    }
  });

  test('sidebar shows settings navigation items', async ({ page }) => {
    await page.goto('/settings/general');
    const sidebar = page.locator(SETTINGS_SIDEBAR);
    // Pages only - blocks such as ACME Server and DNS Resolvers are not in the rail.
    const expectedItems = [
      'General',
      'Responses',
      'Caddy Build',
      'Dashboard Host',
      'Agent',
      'DNS',
      'Network',
      'Authentication',
      'Forward Auth',
      'Geo-blocking',
      'Observability',
    ];
    for (const name of expectedItems) {
      await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible();
    }
  });

  test('sidebar search button is visible with keyboard hint', async ({ page }) => {
    await page.goto('/settings/general');
    const sidebar = page.locator(SETTINGS_SIDEBAR);
    await expect(sidebar.getByText('Search…', { exact: true })).toBeVisible();
    await expect(sidebar.locator('kbd').first()).toBeVisible();
  });
});

// ─── Sidebar navigation ─────────────────────────────────────────────────────

test.describe('Settings - sidebar navigation', () => {
  test('clicking a nav item switches the detail pane', async ({ page }) => {
    await page.goto('/settings/general');
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();

    await page
      .locator(SETTINGS_SIDEBAR)
      .getByRole('link', { name: 'Responses', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Responses' })).toBeVisible();
    // The page it came from is gone, not merely scrolled off.
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).not.toBeVisible();
  });

  test('breadcrumb shows correct group for each section', async ({ page }) => {
    await page.goto('/settings/general');
    const breadcrumb = page.getByTestId('settings-breadcrumb');

    await expect(breadcrumb.getByText('System')).toBeVisible();

    await page.locator(SETTINGS_SIDEBAR).getByRole('link', { name: 'DNS', exact: true }).click();
    await expect(breadcrumb.getByText('Networking')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'DNS Providers' })).toBeVisible();
  });

  test('navigating through all sections renders correct headings', async ({ page }) => {
    await page.goto('/settings/general');
    const sidebar = page.locator(SETTINGS_SIDEBAR);

    const pages = [
      'General',
      'Responses',
      'DNS',
      'Network',
      'Authentication',
      'Forward Auth',
      'Geo-blocking',
      'Observability',
    ];

    for (const name of pages) {
      await sidebar.getByRole('link', { name, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    }
  });

  test('a page shows its own blocks and no others', async ({ page }) => {
    await page.goto('/settings/general');

    // ACME Server is a block on General; Trusted Proxies (on Network) must not be in the document.
    await expect(
      page.getByRole('heading', { level: 1, name: 'General', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'ACME Server', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Trusted Proxies', exact: true }),
    ).not.toBeVisible();
    await expect(pageSave(page)).toHaveCount(0);

    await page
      .locator(SETTINGS_SIDEBAR)
      .getByRole('link', { name: 'Network', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Trusted Proxies', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'ACME Server', exact: true }),
    ).not.toBeVisible();
  });
});

// ─── Cmd-K palette ───────────────────────────────────────────────────────────

test.describe('Settings - Cmd-K palette', () => {
  test('Cmd+K opens the command palette', async ({ page }) => {
    await page.goto('/settings/general');
    await openPaletteWithKeyboard(page);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder(/search/i)).toBeVisible();
  });

  test('clicking the search button opens the command palette', async ({ page }) => {
    await page.goto('/settings/general');
    await waitForHydration(page);
    await page.locator(SETTINGS_SIDEBAR).getByText('Search…', { exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('palette shows all settings items', async ({ page }) => {
    await page.goto('/settings/general');
    await openPaletteWithKeyboard(page);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('General', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Responses', { exact: true })).toBeVisible();
    await expect(dialog.getByText('DNS', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Observability', { exact: true })).toBeVisible();
  });

  test('typing in the palette filters results', async ({ page }) => {
    await page.goto('/settings/general');
    await openPaletteWithKeyboard(page);
    const dialog = page.getByRole('dialog');
    const input = dialog.getByPlaceholder(/search/i);
    // Specific enough that cmdk's fuzzy match reaches nothing unrelated; it matches a block name.
    await input.fill('geob');
    await expect(dialog.getByText('Geo-blocking', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Observability', { exact: true })).not.toBeVisible();
  });

  test('selecting a palette result navigates to that section', async ({ page }) => {
    await page.goto('/settings/general');
    await openPaletteWithKeyboard(page);
    const dialog = page.getByRole('dialog');
    const input = dialog.getByPlaceholder(/search/i);
    await input.fill('logging');
    await dialog.getByText('Observability', { exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Access Logging' })).toBeVisible();
  });

  test('Escape closes the palette', async ({ page }) => {
    await page.goto('/settings/general');
    await openPaletteWithKeyboard(page);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('palette shows "no match" for gibberish query', async ({ page }) => {
    await page.goto('/settings/general');
    await openPaletteWithKeyboard(page);
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder(/search/i).fill('zzzzxyzzy');
    await expect(dialog.getByText(/nothing matches your search/i)).toBeVisible();
  });
});

// ─── General section ─────────────────────────────────────────────────────────

test.describe('Settings - General', () => {
  // FormRow uses <div> labels, not <Label htmlFor>, so inputs are found by name.
  test('shows primary domain and ACME email fields', async ({ page }) => {
    await goToSection(page, 'General');
    await expect(page.locator('input[name="defaultDomain"]')).toBeVisible();
    await expect(page.locator('input[name="acmeEmail"]')).toBeVisible();
  });

  test('fill primary domain and save', async ({ page }) => {
    await goToSection(page, 'General');
    const domainInput = page.locator('input[name="defaultDomain"]');
    await domainInput.fill('test.local');
    await savePage(page);
    await expectStaged(page, 10_000);
  });

  test('primary domain persists after save and page reload', async ({ page }) => {
    await goToSection(page, 'General');
    const domainInput = page.locator('input[name="defaultDomain"]');
    await domainInput.fill('persist-test.local');
    await savePage(page);
    await expectStaged(page, 10_000);

    await goToSection(page, 'General');
    await expect(page.locator('input[name="defaultDomain"]')).toHaveValue('persist-test.local');

    await page.locator('input[name="defaultDomain"]').fill('caddyproxymanager.com');
    await savePage(page);
    await expectStaged(page, 10_000);
  });

  test('a changed text field still reads as changed after the save', async ({ page }) => {
    // Pins why ui/FormBooleanControls repairs only booleans: React re-asserts a controlled text
    // input after the post-action form reset. No reload - repopulating from the database hides it.
    await goToSection(page, 'General');
    const domain = page.locator('input[name="defaultDomain"]');
    const save = pageSave(page);
    const original = await domain.inputValue();

    await domain.fill('reset-check.local');
    await save.click();
    await expectStaged(page, 15_000);
    await expect(domain).toHaveValue('reset-check.local');

    await domain.fill(original);
    await save.click();
    await expectStaged(page, 15_000);
  });

  test('ACME email field accepts email input', async ({ page }) => {
    await goToSection(page, 'General');
    const emailInput = page.locator('input[name="acmeEmail"]');
    await emailInput.fill('test@example.com');
    await expect(emailInput).toHaveValue('test@example.com');
  });
});

// ─── Default Response section (unknown hosts - issue #241) ──────────────────

test.describe('Settings - Default Response', () => {
  test('shows all supported behaviors and conditional custom fields', async ({ page }) => {
    await goToSection(page, 'Default Response');
    const behavior = page.getByRole('combobox', { name: 'Behavior' });
    await expect(behavior).toBeVisible();
    await behavior.click();
    await expect(page.getByRole('option', { name: 'Caddy native behavior' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Custom HTTP response' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Redirect' })).toBeVisible();
    await expect(
      page.getByRole('option', { name: 'No response (abort connection)' }),
    ).toBeVisible();
    await page.getByRole('option', { name: 'Custom HTTP response' }).click();

    await expect(page.locator('input[name="status"]')).toHaveValue('404');
    await expect(page.locator('textarea[name="body"]')).toBeVisible();
    await expect(page.locator('textarea[name="headers"]')).toBeVisible();
  });

  test('saves and reloads a custom response through the settings form', async ({ page }) => {
    await goToSection(page, 'Default Response');
    let behavior = page.getByRole('combobox', { name: 'Behavior' });
    await behavior.click();
    await page.getByRole('option', { name: 'Custom HTTP response' }).click();
    await page.locator('input[name="status"]').fill('451');
    // Unique per run: an earlier run's staged value may already be loaded, leaving nothing to save.
    const body = `Unavailable for legal reasons ${Date.now()}`;
    await page.locator('textarea[name="body"]').fill(body);
    await page
      .locator('textarea[name="headers"]')
      .fill('Content-Type: text/plain; charset=utf-8\nX-Cpm-Ui: saved');
    await savePage(page);
    await expect(page.getByText('Staged. Review and apply to send it to Caddy.')).toBeVisible({
      timeout: 10_000,
    });

    await goToSection(page, 'Default Response');
    behavior = page.getByRole('combobox', { name: 'Behavior' });
    await expect(behavior).toContainText('Custom HTTP response');
    await expect(page.locator('input[name="status"]')).toHaveValue('451');
    await expect(page.locator('textarea[name="body"]')).toHaveValue(body);
    await expect(page.locator('textarea[name="headers"]')).toHaveValue(
      'Content-Type: text/plain; charset=utf-8\nX-Cpm-Ui: saved',
    );

    await behavior.click();
    await page.getByRole('option', { name: 'Caddy native behavior' }).click();
    await savePage(page);
    await expect(page.getByText('Staged. Review and apply to send it to Caddy.')).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ─── ACME Server section (custom ACME directory URL - issue #192) ─────────────

test.describe('Settings - ACME Server', () => {
  const API_SETTINGS_ACME = 'http://localhost:3000/api/v1/settings/acme';
  /** Unique per run: a staged change outlives the reset, so a fixed URL may leave nothing new. */
  const directoryUrl = () => `https://ca.internal.example.com/acme/${Date.now()}/directory`;

  test.afterEach(async ({ page }) => {
    // Without Origin this 403s and the reset silently does nothing.
    const res = await page.request.put(API_SETTINGS_ACME, {
      headers: { Origin: SETTINGS_ORIGIN },
      data: { caUrl: '', caRootPem: '' },
    });
    expect(res.ok(), `ACME reset failed: ${res.status()}`).toBe(true);
  });

  test('shows the custom directory URL and CA root fields', async ({ page }) => {
    await goToSection(page, 'ACME Server');
    await expect(page.locator('input[name="caUrl"]')).toBeVisible();
    await expect(page.locator('textarea[name="caRootPem"]')).toBeVisible();
  });

  test('saves a custom directory URL and persists it', async ({ page }) => {
    const customDir = directoryUrl();
    await goToSection(page, 'ACME Server');
    await saveSetting(page, page.locator('input[name="caUrl"]'), customDir);
    await expectStaged(page, 10_000);

    await goToSection(page, 'ACME Server');
    await expect(page.locator('input[name="caUrl"]')).toHaveValue(customDir);
  });

  test('rejects a non-HTTPS directory URL', async ({ page }) => {
    await goToSection(page, 'ACME Server');
    await saveSetting(
      page,
      page.locator('input[name="caUrl"]'),
      'http://ca.internal.example.com/directory',
    );
    await expect(page.getByText(/must use HTTPS/i)).toBeVisible({ timeout: 10_000 });
  });

  test('UI save is reflected in the REST API once applied', async ({ page }) => {
    const customDir = directoryUrl();
    await goToSection(page, 'ACME Server');
    await saveSetting(page, page.locator('input[name="caUrl"]'), customDir);
    await expectStaged(page, 10_000);

    // Staged, so the API still reports the applied value.
    const staged = await page.request.get(API_SETTINGS_ACME);
    expect((await staged.json()).caUrl ?? '').not.toBe(customDir);

    await applyStagedChanges(page);

    const res = await page.request.get(API_SETTINGS_ACME);
    const data = await res.json();
    expect(data.caUrl).toBe(customDir);
  });
});

// ─── Dashboard Host section ──────────────────────────────────────────────────

test.describe('Settings - Dashboard Host', () => {
  test('proxy options save with the host and survive a reload', async ({ page }) => {
    await page.goto('/settings/dashboard');
    await waitForHydration(page);
    const domain = page.getByRole('textbox', { name: 'Dashboard domain' });
    if ((await domain.inputValue()) === '') await domain.fill('dashboard-e2e.example.test');

    await page.getByText('Proxy options', { exact: true }).click();
    const hstsSubdomains = page.getByRole('switch', { name: 'HSTS Subdomains' });
    await expect(hstsSubdomains).toBeVisible();
    const before = await hstsSubdomains.isChecked();
    await hstsSubdomains.click();

    // Its own Save, not the page's bar: this form confirms before saving.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectStaged(page, 10_000);
    await applyStagedChanges(page);

    await page.reload();
    await waitForHydration(page);
    await page.getByText('Proxy options', { exact: true }).click();
    const reloaded = page.getByRole('switch', { name: 'HSTS Subdomains' });
    if (before) await expect(reloaded).not.toBeChecked();
    else await expect(reloaded).toBeChecked();
  });
});

// ─── DNS Providers section ───────────────────────────────────────────────────

test.describe('Settings - DNS Providers', () => {
  test('shows provider selector and add form', async ({ page }) => {
    await goToSection(page, 'DNS Providers');
    await expect(page.getByRole('heading', { level: 2, name: 'DNS Providers' })).toBeVisible();
    // Not text matching /select/ - hidden option labels match too, and need not be visible.
    await expect(page.locator('form#dnsp-add-form button[aria-haspopup="listbox"]')).toBeVisible();
  });

  test('selecting a provider reveals its credential fields', async ({ page }) => {
    await goToSection(page, 'DNS Providers');
    // With hasSearch the trigger is not a combobox - the popup's search input owns that role.
    const providerSelect = page.locator('form#dnsp-add-form button[aria-haspopup="listbox"]');

    await providerSelect.click();
    const firstProvider = page
      .getByRole('option')
      .filter({ hasNot: page.locator('text=/select/i') })
      .first();
    await firstProvider.click();
    const formInputs = page.locator(
      // Excludes the Selector's hidden search box, which `.first()` would otherwise pick.
      'form#dnsp-add-form input[type="text"]:not([role="combobox"]), form#dnsp-add-form input[type="password"]',
    );
    await expect(formInputs.first()).toBeVisible({ timeout: 3000 });
  });
});

// ─── DNS Resolvers section ───────────────────────────────────────────────────

test.describe('Settings - DNS Resolvers', () => {
  test('shows enable checkbox and resolver textareas', async ({ page }) => {
    await goToSection(page, 'DNS Resolvers');
    await expect(page.getByRole('heading', { level: 2, name: 'DNS Resolvers' })).toBeVisible();
    await expect(page.getByLabel('Enable custom DNS resolvers')).toBeVisible();
    await expect(page.locator('textarea[name="resolvers"]')).toBeVisible();
    await expect(page.locator('textarea[name="fallbacks"]')).toBeVisible();
  });

  test('timeout field is visible', async ({ page }) => {
    await goToSection(page, 'DNS Resolvers');
    await expect(page.locator('input[name="timeout"]')).toBeVisible();
  });
});

// ─── Upstream DNS Pinning section ────────────────────────────────────────────

test.describe('Settings - Upstream DNS Pinning', () => {
  test('shows enable checkbox and address family selector', async ({ page }) => {
    await goToSection(page, 'Upstream DNS Pinning');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upstream DNS Pinning' }),
    ).toBeVisible();
    await expect(page.getByLabel('Enable upstream DNS pinning')).toBeVisible();
  });

  test('address family selector shows three options', async ({ page }) => {
    await goToSection(page, 'Upstream DNS Pinning');
    await page.getByRole('combobox', { name: 'Address family' }).click();
    await expect(page.getByRole('option', { name: /both/i })).toBeVisible();
    await expect(page.getByRole('option', { name: /ipv6 only/i })).toBeVisible();
    await expect(page.getByRole('option', { name: /ipv4 only/i })).toBeVisible();
  });

  test('a changed toggle still reads as changed after the save', async ({ page }) => {
    // React 19's post-action form reset snaps a toggle back to its mounted value after the last
    // render (see ui/FormBooleanControls). It must change before saving, or the reset hides it.
    await goToSection(page, 'Upstream DNS Pinning');
    const toggle = page.getByLabel('Enable upstream DNS pinning');
    const save = pageSave(page);

    const initial = await toggle.isChecked();
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: !initial });

    await save.click();
    await expectStaged(page, 15_000);
    await expect(toggle).toBeChecked({ checked: !initial });

    await toggle.click();
    await expect(toggle).toBeChecked({ checked: initial });

    await save.click();
    await expectStaged(page, 15_000);
  });
});

// ─── Authentik Defaults section ──────────────────────────────────────────────

test.describe('Settings - Authentik Defaults', () => {
  test('shows outpost domain, upstream, and auth endpoint fields', async ({ page }) => {
    await goToSection(page, 'Authentik Defaults');
    await expect(page.getByRole('heading', { level: 2, name: 'Authentik Defaults' })).toBeVisible();
    await expect(page.locator('input[name="outpostDomain"]')).toBeVisible();
    await expect(page.locator('input[name="outpostUpstream"]')).toBeVisible();
    await expect(page.locator('input[name="authEndpoint"]')).toBeVisible();
  });

  test('fields have appropriate placeholders', async ({ page }) => {
    await goToSection(page, 'Authentik Defaults');
    await expect(page.locator('input[name="outpostDomain"]')).toHaveAttribute(
      'placeholder',
      'outpost.goauthentik.io',
    );
    await expect(page.locator('input[name="outpostUpstream"]')).toHaveAttribute(
      'placeholder',
      'http://authentik-server:9000',
    );
  });
});

// ─── OAuth Providers section ─────────────────────────────────────────────────

test.describe('Settings - OAuth Providers', () => {
  test('section renders with Add Provider button', async ({ page }) => {
    await goToSection(page, 'OAuth Providers');
    await expect(page.getByRole('heading', { level: 2, name: 'OAuth Providers' })).toBeVisible();
    await expect(page.getByRole('button', { name: /add provider/i })).toBeVisible();
  });

  test('clicking Add Provider opens dialog', async ({ page }) => {
    await goToSection(page, 'OAuth Providers');
    await page.getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/name/i)).toBeVisible();
    await expect(dialog.getByLabel(/client id/i)).toBeVisible();
    await expect(dialog.getByLabel(/client secret/i)).toBeVisible();
  });

  test('create and delete an OAuth provider', async ({ page }) => {
    await goToSection(page, 'OAuth Providers');
    await page.getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^name/i).fill('E2E Test Provider');
    await dialog.getByLabel(/client id/i).fill('test-client-id-12345');
    await dialog.getByLabel(/client secret/i).fill('test-client-secret-12345');
    // No issuer URL, so no OIDC discovery.
    await dialog.getByRole('button', { name: /create provider/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });

    await expect(page.getByText('E2E Test Provider')).toBeVisible({ timeout: 10_000 });

    // "Delete provider" is only the tooltip.
    await page.getByRole('button', { name: 'Delete E2E Test Provider' }).click();
    // role="alertdialog", not "dialog".
    const confirm = page.getByRole('alertdialog', { name: /delete oauth provider/i });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete provider', exact: true }).click();
    await expect(page.getByText('E2E Test Provider', { exact: true })).not.toBeVisible({
      timeout: 10_000,
    });
  });

  test('existing OAuth secrets never cross the API or React browser boundary', async ({ page }) => {
    await page.goto('/settings/general');
    const origin = new URL(page.url()).origin;
    const secret = `oauth-browser-secret-${Date.now()}`;
    const providerName = `Write-only OAuth ${Date.now()}`;
    const createResponse = await page.request.post(`${origin}/api/v1/oauth-providers`, {
      headers: { Origin: origin },
      data: {
        name: providerName,
        type: 'oidc',
        clientId: 'browser-boundary-client-id',
        clientSecret: secret,
        scopes: 'openid email profile',
      },
    });
    const createBody = await createResponse.text();
    const created = JSON.parse(createBody) as { id: string; hasClientSecret: boolean };

    expect(createResponse.ok()).toBeTruthy();
    expect(created.hasClientSecret).toBe(true);
    expect(createBody).not.toContain(secret);
    expect(createBody).not.toContain('clientSecret');

    try {
      const navigation = await page.goto('/settings/general');
      const initialRscHtml = await navigation!.text();
      expect(initialRscHtml).not.toContain(secret);
      expect(initialRscHtml).not.toContain('clientSecret');
      expect(await page.content()).not.toContain(secret);

      const itemResponse = await page.request.get(`${origin}/api/v1/oauth-providers/${created.id}`);
      const itemBody = await itemResponse.text();
      expect(itemResponse.ok()).toBeTruthy();
      expect(itemBody).not.toContain(secret);
      expect(itemBody).not.toContain('clientSecret');

      await goToSection(page, 'OAuth Providers');
      // The accessible name carries the timestamped provider name, so no card scoping.
      await page.getByRole('button', { name: `Edit ${providerName}` }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(/existing value cannot be viewed/i)).toBeVisible();
      await expect(dialog.getByLabel(/client secret/i)).toHaveCount(0);
      await dialog.getByRole('button', { name: /rotate secret/i }).click();
      await expect(dialog.getByLabel(/new client secret/i)).toHaveValue('');
      await dialog.getByRole('button', { name: /keep existing/i }).click();

      await dialog.getByLabel(/^name/i).fill(`${providerName} renamed`);
      await dialog.getByRole('button', { name: /update provider/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });

      const preservedResponse = await page.request.get(
        `${origin}/api/v1/oauth-providers/${created.id}`,
      );
      const preserved = (await preservedResponse.json()) as { hasClientSecret: boolean };
      expect(preserved.hasClientSecret).toBe(true);
    } finally {
      await page.request
        .delete(`${origin}/api/v1/oauth-providers/${created.id}`, {
          headers: { Origin: origin },
        })
        .catch(() => undefined);
    }
  });
});

// ─── Global Geoblocking section ──────────────────────────────────────────────

test.describe('Settings - Global Geoblocking', () => {
  test('section renders with save button', async ({ page }) => {
    await goToSection(page, 'Global Geoblocking');
    await expect(page.getByRole('heading', { level: 2, name: 'Global Geoblocking' })).toBeVisible();
  });
});

// ─── Metrics & Monitoring section ────────────────────────────────────────────

test.describe('Settings - Metrics & Monitoring', () => {
  test('shows enable checkbox and port field', async ({ page }) => {
    await goToSection(page, 'Metrics & Monitoring');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Metrics & Monitoring' }),
    ).toBeVisible();
    await expect(page.getByLabel('Enable metrics endpoint')).toBeVisible();
    await expect(page.locator('input[name="port"]')).toBeVisible();
  });

  test('port field has default value 9090', async ({ page }) => {
    await goToSection(page, 'Metrics & Monitoring');
    await expect(page.locator('input[name="port"]')).toHaveValue('9090');
  });

  test('info callout mentions Docker network scrape endpoint', async ({ page }) => {
    await goToSection(page, 'Metrics & Monitoring');
    await expect(page.getByText(/Scrape http:\/\/caddy-proxy-manager-caddy/i)).toBeVisible();
  });
});

// ─── Access Logging section ──────────────────────────────────────────────────

test.describe('Settings - Access Logging', () => {
  test('shows enable checkbox and format selector', async ({ page }) => {
    await goToSection(page, 'Access Logging');
    await expect(page.getByRole('heading', { level: 2, name: 'Access Logging' })).toBeVisible();
    await expect(page.getByLabel('Enable access logging')).toBeVisible();
  });

  test('format selector has JSON and Console options', async ({ page }) => {
    await goToSection(page, 'Access Logging');
    await page.getByRole('combobox', { name: 'Format' }).click();
    await expect(page.getByRole('option', { name: 'JSON' })).toBeVisible();
    await expect(page.getByRole('option', { name: /console/i })).toBeVisible();
  });

  test('info callout mentions docker exec command', async ({ page }) => {
    await goToSection(page, 'Access Logging');
    await expect(page.getByText(/docker exec/)).toBeVisible();
  });
});

// ─── Updates section ─────────────────────────────────────────────────────────

test.describe('Settings - Updates', () => {
  test('shows the running version, the toggle and the repository', async ({ page }) => {
    await goToSection(page, 'Updates');
    await expect(page.getByRole('heading', { name: 'Release updates' })).toBeVisible();
    await expect(page.getByLabel('Check for updates')).toBeVisible();

    await expect(page.locator('input[name="updateImageRepository"]')).toHaveValue(
      /^[a-z0-9.]+\/[a-z0-9._/-]+$/,
    );
    await expect(page.getByRole('button', { name: 'Check now' })).toBeVisible();
  });

  test('the repository field takes a different namespace', async ({ page }) => {
    // Typed, not saved: saving reaches the registry, and this suite must not depend on ghcr.io.
    await goToSection(page, 'Updates');
    const repository = page.locator('input[name="updateImageRepository"]');
    await repository.fill('ghcr.io/somerandomuser/caddy-proxy-manager');
    await expect(repository).toHaveValue('ghcr.io/somerandomuser/caddy-proxy-manager');
  });

  test('turning the check off disables the repository field', async ({ page }) => {
    await goToSection(page, 'Updates');
    await page.getByLabel('Check for updates').click();
    // By role: a disabled Astryx input drops its name attribute (and so submits nothing).
    await expect(page.getByRole('textbox', { name: 'Image repository' })).toBeDisabled();
  });
});

// ─── Cross-section navigation ────────────────────────────────────────────────

test.describe('Settings - cross-section navigation', () => {
  test('rapid section switching renders correct content each time', async ({ page }) => {
    await page.goto('/settings/general');
    // A click before hydration races the router; CI lost the Observability heading to it.
    await waitForHydration(page);
    const sidebar = page.locator(SETTINGS_SIDEBAR);

    await sidebar.getByRole('link', { name: 'General', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();

    await sidebar.getByRole('link', { name: 'Observability', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Metrics & Monitoring' }),
    ).toBeVisible();

    await sidebar.getByRole('link', { name: 'Authentication', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'OAuth Providers' })).toBeVisible();

    await sidebar.getByRole('link', { name: 'General', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  });

  test('Cmd-K to navigate, then sidebar to navigate back', async ({ page }) => {
    await page.goto('/settings/general');
    await waitForHydration(page);

    await openPaletteWithKeyboard(page);
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder(/search/i).fill('access logging');
    await dialog.getByText('Observability', { exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Access Logging' })).toBeVisible();

    await page
      .locator(SETTINGS_SIDEBAR)
      .getByRole('link', { name: 'General', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  });
});

// ─── Mobile layout ───────────────────────────────────────────────────────────

test.describe('Settings - mobile layout', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  /** A phone has no rail and no section picker; the overview's tiles link to each section. */
  test('the settings rail is not stacked inline; the overview links to each section', async ({
    page,
  }) => {
    await page.goto('/settings/general');
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();

    await expect(page.getByRole('link', { name: 'DNS Providers', exact: true })).not.toBeVisible();

    await page.goto('/settings');
    const tile = page.getByTestId(/^settings-tile-/).filter({ hasText: 'DNS Providers' });
    await expect(tile).toBeVisible();
    await tile.click();
    await expect(page.getByRole('heading', { level: 1, name: 'DNS' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'DNS Providers' })).toBeVisible();
  });

  test('a section route renders its own section at mobile width', async ({ page }) => {
    await page.goto('/settings/observability');
    await expect(page.getByRole('heading', { level: 1, name: 'Observability' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Metrics & Monitoring' }),
    ).toBeVisible();
  });

  /** Old section ids are links people still hold. */
  test('a link to a setting that moved lands on the page that carries it', async ({ page }) => {
    await page.goto('/settings/metrics');
    await expect(page).toHaveURL(/\/settings\/observability#metrics$/);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Metrics & Monitoring' }),
    ).toBeVisible();
  });

  test('the header still names the page and carries the revision', async ({ page }) => {
    await page.goto('/settings/general');
    const header = page.getByTestId('settings-header');
    await expect(header.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  });

  test('detail content does not overflow viewport width', async ({ page }) => {
    await page.goto('/settings/general');
    await page.waitForLoadState('networkidle');
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = page.viewportSize()?.width ?? 393;
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 5);
  });
});

// ─── Form submissions via API ────────────────────────────────────────────────

test.describe('Settings - form data round-trip via API', () => {
  const API_SETTINGS_GENERAL = 'http://localhost:3000/api/v1/settings/general';
  const API_SETTINGS_METRICS = 'http://localhost:3000/api/v1/settings/metrics';
  const API_SETTINGS_LOGGING = 'http://localhost:3000/api/v1/settings/logging';

  test('general settings: UI save is reflected in API', async ({ page }) => {
    await goToSection(page, 'General');
    await page.locator('input[name="defaultDomain"]').fill('api-roundtrip.local');
    await savePage(page);
    await expectStaged(page, 10_000);
    await applyStagedChanges(page);

    const res = await page.request.get(API_SETTINGS_GENERAL);
    const data = await res.json();
    expect(data.defaultDomain).toBe('api-roundtrip.local');

    // Reset
    await page.request.put(API_SETTINGS_GENERAL, {
      headers: { Origin: SETTINGS_ORIGIN },
      data: { defaultDomain: 'caddyproxymanager.com', acmeEmail: '' },
    });
  });

  test('metrics settings: enable and change port via UI, verify via API', async ({ page }) => {
    await goToSection(page, 'Metrics & Monitoring');
    const enableCheckbox = page.getByLabel('Enable metrics endpoint');
    if (!(await enableCheckbox.isChecked())) {
      await enableCheckbox.click();
    }
    await page.locator('input[name="port"]').fill('9191');
    await savePage(page);
    await expectStaged(page, 10_000);
    await applyStagedChanges(page);

    const res = await page.request.get(API_SETTINGS_METRICS);
    const data = await res.json();
    expect(data.enabled).toBe(true);
    expect(data.port).toBe(9191);

    // Reset
    await page.request.put(API_SETTINGS_METRICS, {
      headers: { Origin: SETTINGS_ORIGIN },
      data: { enabled: false, port: 9090 },
    });
  });

  test('logging settings: change format via UI, verify via API', async ({ page }) => {
    await goToSection(page, 'Access Logging');
    const enableCheckbox = page.getByLabel('Enable access logging');
    if (!(await enableCheckbox.isChecked())) {
      await enableCheckbox.click();
    }
    await page.getByRole('combobox', { name: 'Format' }).click();
    await page.getByRole('option', { name: /console/i }).click();
    await savePage(page);
    await expectStaged(page, 10_000);
    await applyStagedChanges(page);

    const res = await page.request.get(API_SETTINGS_LOGGING);
    const data = await res.json();
    expect(data.format).toBe('console');

    // Reset
    await page.request.put(API_SETTINGS_LOGGING, {
      headers: { Origin: SETTINGS_ORIGIN },
      data: { enabled: false, format: 'json' },
    });
  });
});

// ─── Detail header ───────────────────────────────────────────────────────────

test.describe('Settings - detail header', () => {
  test('header shows the page title with no description under it', async ({ page }) => {
    // Asks the header, not the page: each block still has its own description.
    await goToSection(page, 'General');
    const header = page.getByTestId('settings-header');
    await expect(header.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
    await expect(header.getByText('Primary domain and ACME contact email')).toHaveCount(0);
  });

  test('header breadcrumb trail includes Settings prefix', async ({ page }) => {
    await page.goto('/settings/general');
    const breadcrumb = page.getByTestId('settings-breadcrumb');
    await expect(breadcrumb.getByText('Settings')).toBeVisible();
  });
});
