/**
 * Functional: access-list IP rules, "Satisfy Any" and "Pass auth to host", through a real Caddy.
 * Domains: func-ipdeny.test, func-ipany.test, func-strip.test
 */
import { test, expect, type Page } from '@playwright/test';
import { createAccessList, createProxyHost } from '../../helpers/proxy-api';
import { httpGet, waitForRoute } from '../../helpers/http';
import { waitForHydration } from '../../helpers/hydration';

const USER = { username: 'ipuser', password: 'S3cur3P@ss!' };
const EVERYWHERE = ['0.0.0.0/0', '::/0'];

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function openList(page: Page, name: string, tab: RegExp) {
  await page.goto('/access-lists');
  await waitForHydration(page);
  await page.getByRole('button', { name: new RegExp(`^${name} `) }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: tab }).click();
}

async function setRules(page: Page, name: string, action: 'Allow' | 'Deny', cidrs: string[]) {
  await openList(page, name, /^network/i);
  for (const [index, cidr] of cidrs.entries()) {
    await page.getByRole('button', { name: /add rule/i }).click();
    const ranges = page.getByPlaceholder('192.168.1.0/24');
    await ranges.nth(index).fill(cidr);
    if (action === 'Deny') {
      await page
        .getByRole('combobox', { name: /action/i })
        .nth(index)
        .click();
      await page.getByRole('option', { name: 'Deny', exact: true }).click();
    }
  }
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(
    page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: /^network/i }),
  ).toContainText(String(cidrs.length));
}

test.describe
  .serial('Access list IP rules', () => {
    test('setup: a list that denies every address', async ({ page }) => {
      await createAccessList(page, 'IP Deny All', []);
      await setRules(page, 'IP Deny All', 'Deny', EVERYWHERE);
      await createProxyHost(page, {
        name: 'Functional IP Deny',
        domain: 'func-ipdeny.test',
        upstream: 'echo-server:8080',
        accessListName: 'IP Deny All',
      });
      await waitForRoute('func-ipdeny.test');
    });

    test('a denied address is refused, password or not', async () => {
      expect((await httpGet('func-ipdeny.test')).status).toBe(403);
    });

    test('setup: Satisfy Any with every address allowed', async ({ page }) => {
      await createAccessList(page, 'IP Any', [USER]);
      await setRules(page, 'IP Any', 'Allow', EVERYWHERE);
      await openList(page, 'IP Any', /^settings/i);
      await page.getByRole('combobox', { name: /satisfy/i }).click();
      await page.getByRole('option', { name: /^any/i }).click();
      await expect(page.getByText(/saved/i).first()).toBeVisible();
      await createProxyHost(page, {
        name: 'Functional IP Any',
        domain: 'func-ipany.test',
        upstream: 'echo-server:8080',
        accessListName: 'IP Any',
      });
      await waitForRoute('func-ipany.test');
    });

    test('an allowed address skips the password under Satisfy Any', async () => {
      const res = await httpGet('func-ipany.test');
      expect(res.status).toBe(200);
      expect(res.body).toContain('echo-ok');
    });
  });

test.describe
  .serial('Pass auth to host', () => {
    test('setup: a password list in front of a header-echoing upstream', async ({ page }) => {
      await createAccessList(page, 'Strip Auth', [USER]);
      await createProxyHost(page, {
        name: 'Functional Strip Auth',
        domain: 'func-strip.test',
        upstream: 'whoami-server:80',
        accessListName: 'Strip Auth',
      });
      await waitForRoute('func-strip.test');
    });

    test('the upstream never sees the credentials by default', async () => {
      const res = await httpGet('func-strip.test', '/', {
        Authorization: basicAuth(USER.username, USER.password),
      });
      expect(res.status).toBe(200);
      expect(res.body).not.toMatch(/^Authorization:/im);
    });

    test('and sees them once Pass auth to host is on', async ({ page }) => {
      await openList(page, 'Strip Auth', /^settings/i);
      await page.getByRole('switch', { name: /pass auth to host/i }).click();
      await expect(page.getByText(/saved/i).first()).toBeVisible();
      await expect(async () => {
        const res = await httpGet('func-strip.test', '/', {
          Authorization: basicAuth(USER.username, USER.password),
        });
        expect(res.body).toMatch(/^Authorization: Basic /im);
      }).toPass({ timeout: 20_000 });
    });
  });
