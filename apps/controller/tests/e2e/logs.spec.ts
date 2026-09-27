/**
 * E2E: the log viewer reads Caddy's own output through the stack's real agent, and a proxy host's
 * Logs action opens its access log.
 */
import { test, expect } from '@playwright/test';
import { waitForHydration } from '../helpers/hydration';
import { createProxyHost } from '../helpers/proxy-api';

test('shows Caddy output read through the agent', async ({ page }) => {
  await page.goto('/logs?source=caddy');
  await waitForHydration(page);
  // Caddy logs as JSON; any line of it has a level.
  await expect(page.getByText(/"level":/).first()).toBeVisible({ timeout: 30_000 });
});

test('opens from a proxy host, narrowed to its domain', async ({ page }) => {
  await createProxyHost(page, {
    name: 'Logs Action Host',
    domain: 'logs-action.test',
    upstream: 'echo-server:8080',
  });
  await page.getByRole('button', { name: 'Actions for Logs Action Host' }).click();
  await page.getByRole('menuitem', { name: /^logs$/i }).click();
  await expect(page).toHaveURL(/\/logs\?source=access&host=logs-action\.test/);
  await waitForHydration(page);
  await expect(page.getByRole('textbox', { name: /filter/i }).first()).toHaveValue(
    'logs-action.test',
  );
});
