/**
 * E2E: the generic forward-auth provider in the UI (real-Caddy behaviour is in functional/). The
 * defaults prefill the host dialog, and the dialog keeps the API split and its bypass headers.
 */
import { test, expect } from '@playwright/test';
import { goToSetting } from '../../helpers/settings-nav';
import { applyStagedChanges, expectStaged } from '../../helpers/staged-settings';
import { waitForHydration } from '../../helpers/hydration';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const API_FORWARD_AUTH_SETTINGS = 'http://localhost:3000/api/v1/settings/forward-auth';

type ForwardAuthSettings = { provider?: string; authUpstream?: string; authEndpoint?: string };

test.describe('Generic forward auth', () => {
  test('defaults save in settings and prefill the create dialog', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const defaults = {
      provider: 'authelia',
      authUpstream: 'http://authelia.internal:9091',
      authEndpoint: '/api/authz/forward-auth',
    };

    const originalResp = await page.request.get(API_FORWARD_AUTH_SETTINGS);
    const original = (await originalResp.json()) as ForwardAuthSettings | null;

    try {
      await goToSetting(page, 'Forward Auth Defaults');

      await page.locator('input[name="forwardAuthUpstream"]').fill(defaults.authUpstream);
      await page.locator('input[name="forwardAuthEndpoint"]').fill(defaults.authEndpoint);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      // Settings stage rather than write through, and the dialog prefills from what is applied.
      await expectStaged(page);
      await applyStagedChanges(page);

      await page.goto('/proxy-hosts');
      await waitForHydration(page);
      await page.getByRole('button', { name: /create host/i }).click();
      await expect(page.getByRole('dialog')).toBeVisible();

      const dialog = page.getByRole('dialog');
      const section = dialog.locator('div:has(> input[name="forwardAuthPresent"])');
      const toggle = section.getByRole('switch', { name: 'Enable forward auth' });
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();

      await expect(dialog.locator('input[name="forwardAuthUpstream"]')).toHaveValue(
        defaults.authUpstream,
      );
      await expect(dialog.locator('input[name="forwardAuthEndpoint"]')).toHaveValue(
        defaults.authEndpoint,
      );
    } finally {
      if (original?.authUpstream) {
        const restore = await page.request.put(API_FORWARD_AUTH_SETTINGS, {
          headers: { Origin: origin },
          data: {
            provider: original.provider ?? 'authelia',
            authUpstream: original.authUpstream,
            authEndpoint: original.authEndpoint ?? '',
          },
        });
        expect(restore.ok()).toBeTruthy();
      }
    }
  });

  test('a host configured in the dialog keeps its split and bypass headers', async ({ page }) => {
    await page.goto('/proxy-hosts');
    await waitForHydration(page);
    await page.getByRole('button', { name: /create host/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const dialog = page.getByRole('dialog');
    await page.getByLabel('Name').fill('Generic FA UI Host');
    await page.getByLabel(/^domains/i).fill('generic-fa-ui.local');
    await page.getByPlaceholder('10.0.0.5:8080').first().fill('localhost:9988');

    const section = dialog.locator('div:has(> input[name="forwardAuthPresent"])');
    await section.getByRole('switch', { name: 'Enable forward auth' }).click();
    await dialog.locator('input[name="forwardAuthUpstream"]').fill('http://authelia:9091');
    await dialog.getByRole('switch', { name: /answer non-browser callers with 401/i }).click();
    await dialog
      .locator('input[name="forwardAuthApiBypassHeaders"]')
      .fill('X-Api-Key, Authorization');

    await page.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });

    const hosts = (await (await page.request.get(API_PROXY_HOSTS)).json()) as {
      name: string;
      forwardAuth: {
        enabled: boolean;
        provider: string;
        authUpstream: string;
        authEndpoint: string;
        apiSplit: boolean;
        apiBypassHeaders: string[];
      } | null;
    }[];
    const created = hosts.find((host) => host.name === 'Generic FA UI Host');
    expect(created?.forwardAuth).toMatchObject({
      enabled: true,
      provider: 'authelia',
      authUpstream: 'http://authelia:9091',
      // Filled in by the preset rather than typed, which is the point of having one.
      authEndpoint: '/api/authz/forward-auth',
      apiSplit: true,
      apiBypassHeaders: ['X-Api-Key', 'Authorization'],
    });
  });
});
