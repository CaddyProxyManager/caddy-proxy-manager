import { test, expect } from '@playwright/test';
import { goToSetting } from '../../helpers/settings-nav';
import { applyStagedChanges, expectStaged } from '../../helpers/staged-settings';
import { waitForHydration } from '../../helpers/hydration';
import { saveThroughReview } from '../../helpers/host-editor';
import { PROXY_HOSTS_NEWEST_FIRST } from '../../helpers/proxy-api';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const API_AUTHENTIK_SETTINGS = 'http://localhost:3000/api/v1/settings/authentik';

test.describe('Proxy hosts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(PROXY_HOSTS_NEWEST_FIRST);
    // The tests below click New first thing; a click before hydration opens nothing.
    await waitForHydration(page);
  });

  test('page loads with Create Host button visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeVisible();
  });

  test('clicking Create Host opens a dialog with form fields', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel(/^domains/i)).toBeVisible();
  });

  test('create a proxy host - appears in the table', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('E2E Test Host');
    await page.getByLabel(/^domains/i).fill('e2etest.local');
    await page.getByPlaceholder('10.0.0.5:8080').fill('localhost:9999');

    await page.getByRole('button', { name: /^create$/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('table').getByText('E2E Test Host', { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test('clicking Name / Domain header sorts the table', async ({ page }) => {
    const sortBtn = page.getByRole('button', { name: 'Name / domain' });
    await expect(sortBtn).toBeVisible({ timeout: 10_000 });

    await sortBtn.click();
    await expect(page).toHaveURL(/sortBy=name/);
    await expect(page).toHaveURL(/sortDir=asc/);

    await sortBtn.click();
    await expect(page).toHaveURL(/sortDir=desc/);
  });

  test('clicking Status header sorts by enabled state', async ({ page }) => {
    const sortBtn = page.getByRole('button', { name: 'Status' });
    await expect(sortBtn).toBeVisible();

    await sortBtn.click();
    await expect(page).toHaveURL(/sortBy=enabled/);
  });

  /** Regression (#119): the form posted camelCase field names, the action read snake_case. */
  test('advanced options are saved and persist after edit (#119)', async ({ page }) => {
    // Defaults: HSTS Subdomains and Skip HTTPS both off.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Advanced Options Test');
    await page.getByLabel(/^domains/i).fill('advanced-opts-test.local');
    await page.getByPlaceholder('10.0.0.5:8080').fill('localhost:9990');
    await page.getByRole('button', { name: /^create$/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole('table').getByText('Advanced Options Test', { exact: true }),
    ).toBeVisible({
      timeout: 10000,
    });

    try {
      const listResp = await page.request.get(API_PROXY_HOSTS);
      const hosts = (await listResp.json()) as Array<{
        uuid: string;
        name: string;
        hstsSubdomains: boolean;
        skipHttpsHostnameValidation: boolean;
      }>;
      const created = hosts.find((h) => h.name === 'Advanced Options Test');
      expect(created).toBeDefined();
      expect(created!.hstsSubdomains).toBe(false);
      expect(created!.skipHttpsHostnameValidation).toBe(false);

      const row = page.locator('tr', { hasText: 'Advanced Options Test' });
      await row.getByRole('button', { name: /^Actions for / }).click();
      await page.getByRole('menuitem', { name: /edit/i }).click();
      await expect(page.getByRole('dialog')).toBeVisible();

      // Via the hidden _present inputs, which are unique where ancestor divs are not.
      const dialog = page.getByRole('dialog');
      const hstsSwitch = dialog
        .locator('div:has(> input[name="hstsSubdomainsPresent"])')
        .getByRole('switch');
      const skipSwitch = dialog
        .locator('div:has(> input[name="skipHttpsHostnameValidationPresent"])')
        .getByRole('switch');

      await expect(hstsSwitch).not.toBeChecked();
      await expect(skipSwitch).not.toBeChecked();

      await hstsSwitch.click();
      await skipSwitch.click();

      await expect(hstsSwitch).toBeChecked();
      await expect(skipSwitch).toBeChecked();

      await saveThroughReview(page, dialog);
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });

      const afterResp = await page.request.get(`${API_PROXY_HOSTS}/${created!.uuid}`);
      const after = (await afterResp.json()) as {
        hstsSubdomains: boolean;
        skipHttpsHostnameValidation: boolean;
      };
      expect(after.hstsSubdomains).toBe(true);
      expect(after.skipHttpsHostnameValidation).toBe(true);

      await row.getByRole('button', { name: /^Actions for / }).click();
      await page.getByRole('menuitem', { name: /edit/i }).click();
      await expect(page.getByRole('dialog')).toBeVisible();

      const dialog2 = page.getByRole('dialog');
      const hstsSwitch2 = dialog2
        .locator('div:has(> input[name="hstsSubdomainsPresent"])')
        .getByRole('switch');
      const skipSwitch2 = dialog2
        .locator('div:has(> input[name="skipHttpsHostnameValidationPresent"])')
        .getByRole('switch');

      await expect(hstsSwitch2).toBeChecked();
      await expect(skipSwitch2).toBeChecked();

      await dialog2
        .getByRole('button', { name: /cancel|close/i })
        .first()
        .click();
    } finally {
      const listResp2 = await page.request.get(API_PROXY_HOSTS);
      const hosts2 = (await listResp2.json()) as Array<{ uuid: string; name: string }>;
      const toDelete = hosts2.find((h) => h.name === 'Advanced Options Test');
      if (toDelete) {
        // Mutating requests are same-origin checked; without it the cleanup 403s silently.
        await page.request.delete(`${API_PROXY_HOSTS}/${toDelete.uuid}`, {
          headers: { Origin: 'http://localhost:3000' },
        });
      }
    }
  });

  /** Regression (#120): the row switch sent only { enabled }, wiping redirects and rewrite. */
  test('toggling enabled/disabled preserves redirects and rewrite config (#120)', async ({
    page,
  }) => {
    const origin = new URL(page.url()).origin;

    const createResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'Toggle Persistence Test',
        domains: ['toggle-persist.local'],
        upstreams: ['localhost:9988'],
        redirects: [{ from: '/.well-known/carddav', to: '/remote.php/dav/', status: 308 }],
        rewrite: { path_prefix: '/app' },
      },
    });
    expect(createResp.ok()).toBeTruthy();
    const created = (await createResp.json()) as {
      uuid: string;
      redirects: unknown[];
      rewrite: unknown;
    };
    expect(created.redirects).toHaveLength(1);
    expect(created.rewrite).toBeDefined();

    try {
      await page.reload();
      await expect(
        page.getByRole('table').getByText('Toggle Persistence Test', { exact: true }),
      ).toBeVisible({
        timeout: 10000,
      });

      const row = page.locator('tr', { hasText: 'Toggle Persistence Test' });
      const rowSwitch = row.getByRole('switch').first();
      await expect(rowSwitch).toBeChecked();
      await rowSwitch.click();
      await expect(rowSwitch).not.toBeChecked({ timeout: 10000 });

      const afterDisable = (await (
        await page.request.get(`${API_PROXY_HOSTS}/${created.uuid}`)
      ).json()) as {
        redirects: unknown[];
        rewrite: unknown;
        enabled: boolean;
      };
      expect(afterDisable.enabled).toBe(false);
      expect(afterDisable.redirects).toHaveLength(1);
      expect(afterDisable.rewrite).toBeDefined();

      await rowSwitch.click();
      await expect(rowSwitch).toBeChecked({ timeout: 10000 });

      const afterEnable = (await (
        await page.request.get(`${API_PROXY_HOSTS}/${created.uuid}`)
      ).json()) as {
        redirects: unknown[];
        rewrite: unknown;
        enabled: boolean;
      };
      expect(afterEnable.enabled).toBe(true);
      expect(afterEnable.redirects).toHaveLength(1);
      expect(afterEnable.rewrite).toBeDefined();
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.uuid}`, {
        headers: { Origin: origin },
      });
    }
  });

  test('create host Authentik fields are prefilled from global defaults (#141)', async ({
    page,
  }) => {
    const origin = new URL(page.url()).origin;
    const defaultSettings = {
      outpostDomain: 'auth.example.test',
      outpostUpstream: 'http://authentik.internal:9000',
      authEndpoint: '/outpost.goauthentik.io/auth/caddy',
    };

    const originalSettingsResp = await page.request.get(API_AUTHENTIK_SETTINGS);
    expect(originalSettingsResp.ok()).toBeTruthy();
    const originalSettings = (await originalSettingsResp.json()) as Partial<typeof defaultSettings>;

    try {
      await goToSetting(page, 'Authentik defaults');

      await page.locator('input[name="outpostDomain"]').fill(defaultSettings.outpostDomain);
      await page.locator('input[name="outpostUpstream"]').fill(defaultSettings.outpostUpstream);
      await page.locator('input[name="authEndpoint"]').fill(defaultSettings.authEndpoint);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      // Saves stage, and the host form prefills from applied defaults, so apply first.
      await expectStaged(page);
      await applyStagedChanges(page);

      await page.goto(PROXY_HOSTS_NEWEST_FIRST);
      await waitForHydration(page);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();

      const dialog = page.getByRole('dialog');
      const authentikSection = dialog.locator('div:has(> input[name="authentikPresent"])');
      const authentikSwitch = authentikSection.getByRole('switch', {
        name: 'Enable Authentik forward auth',
      });
      await expect(authentikSwitch).not.toBeChecked();

      await authentikSwitch.click();
      await expect(authentikSwitch).toBeChecked();

      await expect(dialog.locator('input[name="authentikOutpostDomain"]')).toHaveValue(
        defaultSettings.outpostDomain,
      );
      await expect(dialog.locator('input[name="authentikOutpostUpstream"]')).toHaveValue(
        defaultSettings.outpostUpstream,
      );
      await expect(dialog.locator('input[name="authentikAuthEndpoint"]')).toHaveValue(
        defaultSettings.authEndpoint,
      );
    } finally {
      if (originalSettings.outpostDomain && originalSettings.outpostUpstream) {
        const restoreResp = await page.request.put(API_AUTHENTIK_SETTINGS, {
          headers: { Origin: origin },
          data: {
            outpostDomain: originalSettings.outpostDomain,
            outpostUpstream: originalSettings.outpostUpstream,
            authEndpoint: originalSettings.authEndpoint ?? '',
          },
        });
        expect(restoreResp.ok()).toBeTruthy();
      }
    }
  });

  /** Regression (#232): the edit dialog never took `authentikDefaults`, leaving Outpost blank. */
  test('edit host Authentik fields are prefilled from global defaults (#232)', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const defaultSettings = {
      outpostDomain: 'edit-defaults.example.test',
      outpostUpstream: 'http://authentik-edit.internal:9000',
      authEndpoint: '/outpost.goauthentik.io/auth/caddy',
    };

    const originalSettings = (await (
      await page.request.get(API_AUTHENTIK_SETTINGS)
    ).json()) as Partial<typeof defaultSettings>;

    // A pre-existing host with no Authentik config of its own.
    const createResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'Authentik Edit Defaults Host',
        domains: ['authentik-edit-defaults.local'],
        upstreams: ['localhost:9987'],
      },
    });
    expect(createResp.ok()).toBeTruthy();
    const created = (await createResp.json()) as { uuid: string };

    try {
      const saveResp = await page.request.put(API_AUTHENTIK_SETTINGS, {
        headers: { Origin: origin },
        data: defaultSettings,
      });
      expect(saveResp.ok()).toBeTruthy();

      await page.goto(PROXY_HOSTS_NEWEST_FIRST);
      await waitForHydration(page);
      const row = page.locator('tr', { hasText: 'Authentik Edit Defaults Host' });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.getByRole('button', { name: /^Actions for / }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      const authentikSection = dialog.locator('div:has(> input[name="authentikPresent"])');
      const authentikSwitch = authentikSection.getByRole('switch', {
        name: 'Enable Authentik forward auth',
      });
      await expect(authentikSwitch).not.toBeChecked();
      await authentikSwitch.click();
      await expect(authentikSwitch).toBeChecked();

      await expect(dialog.locator('input[name="authentikOutpostDomain"]')).toHaveValue(
        defaultSettings.outpostDomain,
      );
      await expect(dialog.locator('input[name="authentikOutpostUpstream"]')).toHaveValue(
        defaultSettings.outpostUpstream,
      );
      await expect(dialog.locator('input[name="authentikAuthEndpoint"]')).toHaveValue(
        defaultSettings.authEndpoint,
      );
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.uuid}`, {
        headers: { Origin: origin },
      });
      if (originalSettings.outpostDomain && originalSettings.outpostUpstream) {
        await page.request.put(API_AUTHENTIK_SETTINGS, {
          headers: { Origin: origin },
          data: {
            outpostDomain: originalSettings.outpostDomain,
            outpostUpstream: originalSettings.outpostUpstream,
            authEndpoint: originalSettings.authEndpoint ?? '',
          },
        });
      }
    }
  });

  /** The other half of #232: defaults only fill blanks, never overwrite a host's own config. */
  test('edit host keeps its own Authentik values instead of global defaults (#232)', async ({
    page,
  }) => {
    const origin = new URL(page.url()).origin;
    const hostSettings = {
      outpostDomain: 'host-specific.example.test',
      outpostUpstream: 'http://host-specific.internal:9000',
    };
    const globalDefaults = {
      outpostDomain: 'global-default.example.test',
      outpostUpstream: 'http://global-default.internal:9000',
      authEndpoint: '/outpost.goauthentik.io/auth/caddy',
    };

    const originalSettings = (await (
      await page.request.get(API_AUTHENTIK_SETTINGS)
    ).json()) as Partial<typeof globalDefaults>;

    const createResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'Authentik Own Values Host',
        domains: ['authentik-own-values.local'],
        upstreams: ['localhost:9986'],
        authentik: {
          enabled: true,
          outpostDomain: hostSettings.outpostDomain,
          outpostUpstream: hostSettings.outpostUpstream,
        },
      },
    });
    expect(createResp.ok()).toBeTruthy();
    const created = (await createResp.json()) as {
      uuid: string;
      authentik: { outpostDomain: string | null; outpostUpstream: string | null } | null;
    };
    // If the payload shape drifts, this would silently assert the default path instead.
    expect(created.authentik?.outpostDomain).toBe(hostSettings.outpostDomain);
    expect(created.authentik?.outpostUpstream).toBe(hostSettings.outpostUpstream);

    try {
      const saveResp = await page.request.put(API_AUTHENTIK_SETTINGS, {
        headers: { Origin: origin },
        data: globalDefaults,
      });
      expect(saveResp.ok()).toBeTruthy();

      await page.goto(PROXY_HOSTS_NEWEST_FIRST);
      await waitForHydration(page);
      const row = page.locator('tr', { hasText: 'Authentik Own Values Host' });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.getByRole('button', { name: /^Actions for / }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // Already enabled, so the fields are visible without touching the switch.
      await expect(dialog.locator('input[name="authentikOutpostDomain"]')).toHaveValue(
        hostSettings.outpostDomain,
      );
      await expect(dialog.locator('input[name="authentikOutpostUpstream"]')).toHaveValue(
        hostSettings.outpostUpstream,
      );
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${created.uuid}`, {
        headers: { Origin: origin },
      });
      if (originalSettings.outpostDomain && originalSettings.outpostUpstream) {
        await page.request.put(API_AUTHENTIK_SETTINGS, {
          headers: { Origin: origin },
          data: {
            outpostDomain: originalSettings.outpostDomain,
            outpostUpstream: originalSettings.outpostUpstream,
            authEndpoint: originalSettings.authEndpoint ?? '',
          },
        });
      }
    }
  });

  /** Regression: `parseGeoBlockConfig` returned `geoblock_mode`, but the input reads camelCase. */
  test('per-host geoblock override mode persists after save', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Geoblock Override Host');
    await page.getByLabel(/^domains/i).fill('geoblock-override.local');
    await page.getByPlaceholder('10.0.0.5:8080').fill('localhost:9991');

    const dialog = page.getByRole('dialog');
    const geoCard = dialog.locator('div:has(> input[name="geoblockPresent"])');
    await geoCard.scrollIntoViewIfNeeded();
    const geoSwitch = geoCard.getByRole('switch').first();
    await geoSwitch.click();
    await expect(geoSwitch).toBeChecked();

    await geoCard.getByRole('radio', { name: 'Override global' }).click();

    await dialog.getByRole('button', { name: /^create$/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole('table').getByText('Geoblock Override Host', { exact: true }),
    ).toBeVisible({
      timeout: 10000,
    });

    const listResp = await page.request.get(API_PROXY_HOSTS);
    const hosts = (await listResp.json()) as Array<{
      uuid: string;
      name: string;
      geoblockMode: string;
    }>;
    const created = hosts.find((h) => h.name === 'Geoblock Override Host');
    expect(created).toBeDefined();
    expect(created!.geoblockMode).toBe('override');

    const row = page.locator('tr', { hasText: 'Geoblock Override Host' });
    await row.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: /edit/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const editGeoCard = page
      .getByRole('dialog')
      .locator('div:has(> input[name="geoblockPresent"])');
    // The radiogroup's state, not a highlight class, which the design system no longer emits.
    await expect(editGeoCard.getByRole('radio', { name: 'Override global' })).toBeChecked();

    await editGeoCard.getByRole('radio', { name: 'Merge with global' }).click();
    await saveThroughReview(page, page.getByRole('dialog', { name: 'Edit proxy host' }));
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });

    const listResp2 = await page.request.get(API_PROXY_HOSTS);
    const hosts2 = (await listResp2.json()) as Array<{ name: string; geoblockMode: string }>;
    const updated = hosts2.find((h) => h.name === 'Geoblock Override Host');
    expect(updated!.geoblockMode).toBe('merge');
  });

  test('delete proxy host removes it from table', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('Name').fill('Host To Delete');
    await page.getByLabel(/^domains/i).fill('delete-me.local');
    await page.getByPlaceholder('10.0.0.5:8080').fill('localhost:7777');
    await page.getByRole('button', { name: /^create$/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('table').getByText('Host To Delete', { exact: true })).toBeVisible({
      timeout: 10000,
    });

    const row = page.locator('tr', { hasText: 'Host To Delete' });
    await row.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /^delete$/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('tbody').getByText('Host To Delete')).not.toBeVisible({
      timeout: 5000,
    });
  });

  test('Forward Auth feature badge shows for hosts with CPM forward auth enabled', async ({
    page,
  }) => {
    const origin = new URL(page.url()).origin;

    // Names avoid "Forward auth" so the exact badge assertions never match a name cell.
    const withResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'FwdAuth Badge Host',
        domains: ['fwdauth-badge.local'],
        upstreams: ['localhost:9777'],
        cpmForwardAuth: { enabled: true },
      },
    });
    expect(withResp.ok()).toBeTruthy();
    const withHost = (await withResp.json()) as {
      uuid: string;
      cpmForwardAuth: { enabled: boolean } | null;
    };
    expect(withHost.cpmForwardAuth?.enabled).toBe(true);

    const withoutResp = await page.request.post(API_PROXY_HOSTS, {
      headers: { Origin: origin },
      data: {
        name: 'Plain Proxy Host',
        domains: ['plain-proxy.local'],
        upstreams: ['localhost:9778'],
      },
    });
    expect(withoutResp.ok()).toBeTruthy();
    const withoutHost = (await withoutResp.json()) as { uuid: string };

    try {
      await page.reload();

      // With analytics on, the list's protection badges call it "Sign-in".
      const badge = /^(Forward auth|Sign-in)$/;
      const enabledRow = page.locator('tr', { hasText: 'FwdAuth Badge Host' });
      await expect(enabledRow.getByText(badge)).toBeVisible({
        timeout: 10000,
      });

      const disabledRow = page.locator('tr', { hasText: 'Plain Proxy Host' });
      await expect(disabledRow).toBeVisible({ timeout: 10000 });
      await expect(disabledRow.getByText(badge)).toHaveCount(0);
    } finally {
      await page.request.delete(`${API_PROXY_HOSTS}/${withHost.uuid}`, {
        headers: { Origin: origin },
      });
      await page.request.delete(`${API_PROXY_HOSTS}/${withoutHost.uuid}`, {
        headers: { Origin: origin },
      });
    }
  });

  /**
   * Regression: index keys reconciled rows onto their predecessors' DOM nodes. Controlled inputs
   * hide that from value assertions, so nodes are stamped with an expando React never touches.
   */
  test('removing an upstream keeps every other row on its own DOM node', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const addresses = page.getByPlaceholder('10.0.0.5:8080');
    await page.getByRole('button', { name: /add upstream/i }).click();
    await page.getByRole('button', { name: /add upstream/i }).click();
    await expect(addresses).toHaveCount(3);

    await addresses.nth(0).fill('first:1111');
    await addresses.nth(1).fill('second:2222');
    await addresses.nth(2).fill('third:3333');

    await addresses.evaluateAll((nodes) => {
      nodes.forEach((node, i) => {
        (node as HTMLElement & { __rowProbe?: string }).__rowProbe = `probe-${i}`;
      });
    });

    await page.getByRole('button', { name: 'Remove upstream 1' }).click();
    await expect(addresses).toHaveCount(2);

    await expect(addresses.nth(0)).toHaveValue('second:2222');
    await expect(addresses.nth(1)).toHaveValue('third:3333');

    // With index keys these read ['probe-0', 'probe-1'].
    const probes = await addresses.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement & { __rowProbe?: string }).__rowProbe ?? null),
    );
    expect(probes).toEqual(['probe-1', 'probe-2']);
  });
});
