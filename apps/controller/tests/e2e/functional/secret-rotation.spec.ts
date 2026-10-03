/**
 * SESSION_SECRET rotation on the real web container. Three stored secrets - the SMTP password, a
 * DNS provider credential and an OAuth client secret - are saved under the suite's secret; web is
 * restarted with a new one and the old as SESSION_SECRET_PREVIOUS, then again with no previous at
 * all. Mail still goes through mailpit's SMTP auth and Keycloak still accepts the client secret,
 * so all were re-encrypted, not merely readable. The original secret is restored the same way.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { COMPOSE_ARGS, COMPOSE_CWD } from '../../helpers/compose';
import { decryptUnderSecret } from '../../helpers/encrypt-under-other-secret';
import { waitForHydration } from '../../helpers/hydration';
import {
  KC_USER,
  keycloakProviderBody,
  launchKeycloakBrowser,
  logoutUserEverywhere,
  newSignedOutContext,
  signInThroughKeycloak,
} from '../../helpers/keycloak';
import {
  SMTP,
  SMTP_SETTING_KEYS,
  configureSmtp,
  deleteAllMail,
  removeSmtp,
  waitForMail,
} from '../../helpers/mailpit';
import * as seed from '../../helpers/seed';

const BASE = 'http://localhost:3000';
const API = `${BASE}/api/v1`;
/** tests/docker-compose.test.yml's default for web. */
const ORIGINAL = 'test-session-secret-32chars!xxxY';
const ROTATED = 'rotated-e2e-session-secret-0123456789ab';
const DNS_TOKEN = `cf-rotation-token-${Date.now()}`;

/** Recreates web with this secret pair and waits for it to answer. */
async function restartWeb(secret: string | null, previous: string | null): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.E2E_WEB_SESSION_SECRET;
  delete env.E2E_WEB_SESSION_SECRET_PREVIOUS;
  if (secret) env.E2E_WEB_SESSION_SECRET = secret;
  if (previous) env.E2E_WEB_SESSION_SECRET_PREVIOUS = previous;
  execFileSync('docker', [...COMPOSE_ARGS, 'up', '-d', '--no-deps', 'web'], {
    cwd: COMPOSE_CWD,
    env,
    stdio: 'pipe',
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${BASE}/api/health`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe(200);
}

function readStored(): { smtpPassword: string; dnsToken: string; clientSecrets: string[] } {
  const output = seed.runSeedScript(`
    const [smtp] = await sql\`SELECT value FROM settings WHERE key = 'config:smtp_password'\`;
    const [dns] = await sql\`SELECT value FROM settings WHERE key = 'dns_provider'\`;
    const providers = await sql\`SELECT "clientSecret" FROM oauth_providers WHERE source = 'ui'\`;
    console.log(JSON.stringify({
      smtpPassword: smtp ? JSON.parse(smtp.value) : '',
      dnsToken: dns ? JSON.parse(dns.value).providers?.cloudflare?.api_token ?? '' : '',
      clientSecrets: providers.map((p) => p.clientSecret),
    }));
    await sql.close();
  `);
  return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
}

async function adminPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await ctx.request.post(`${BASE}/api/auth/sign-in/username`, {
    headers: { Origin: BASE },
    data: { username: 'testadmin', password: 'TestPassword2026!' },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ctx.newPage();
}

test.describe
  .serial('SESSION_SECRET rotation', () => {
    test.setTimeout(240_000);
    let providerId: string | null = null;
    let savedDns: string | null = null;
    const providerName = `Rotation Keycloak ${Date.now()}`;

    test.beforeAll(() => {
      const output = seed.runSeedScript(`
        const [dns] = await sql\`SELECT value FROM settings WHERE key = 'dns_provider'\`;
        console.log('DNS:' + JSON.stringify(dns?.value ?? null));
        await sql.close();
      `);
      savedDns = JSON.parse(output.slice(output.indexOf('DNS:') + 4).trim());
    });

    // Whatever failed: both steps, so a value under either key ends under the original.
    test.afterAll(async ({ browser }) => {
      test.setTimeout(300_000);
      await restartWeb(ORIGINAL, ROTATED);
      await restartWeb(null, null);
      const page = await adminPage(browser);
      if (providerId) {
        await page.request.delete(`${API}/oauth-providers/${providerId}`, {
          headers: { Origin: BASE },
        });
      }
      await removeSmtp(page);
      await page.context().close();
      await logoutUserEverywhere().catch(() => {});
      seed.deleteUserByEmail(KC_USER.email);
      for (const key of SMTP_SETTING_KEYS) seed.clearSettingRow(key);
      if (savedDns === null) seed.clearSettingRow('dns_provider');
      else seed.setSettingRow('dns_provider', JSON.parse(savedDns));
    });

    test('secrets are stored under the current key', async ({ page }) => {
      await configureSmtp(page);
      const dns = await page.request.put(`${API}/settings/dns-provider`, {
        headers: { Origin: BASE },
        data: { providers: { cloudflare: { api_token: DNS_TOKEN } }, default: null },
      });
      expect(dns.ok(), await dns.text()).toBe(true);
      const created = await page.request.post(`${API}/oauth-providers`, {
        headers: { Origin: BASE },
        data: keycloakProviderBody(providerName),
      });
      expect(created.ok(), await created.text()).toBe(true);
      providerId = (await created.json()).id;

      const stored = readStored();
      expect(decryptUnderSecret(stored.smtpPassword, ORIGINAL)).toBe(SMTP.password);
      expect(decryptUnderSecret(stored.dnsToken, ORIGINAL)).toBe(DNS_TOKEN);
      expect(stored.clientSecrets.map((s) => decryptUnderSecret(s, ORIGINAL))).toContain(
        'cpm-keycloak-secret',
      );
    });

    test('a restart with the new secret and the old as previous re-encrypts them', async () => {
      await restartWeb(ROTATED, ORIGINAL);
      const stored = readStored();
      expect(decryptUnderSecret(stored.smtpPassword, ROTATED)).toBe(SMTP.password);
      expect(decryptUnderSecret(stored.dnsToken, ROTATED)).toBe(DNS_TOKEN);
      expect(stored.clientSecrets.map((s) => decryptUnderSecret(s, ROTATED))).toContain(
        'cpm-keycloak-secret',
      );
      expect(decryptUnderSecret(stored.smtpPassword, ORIGINAL)).toBeNull();
    });

    test('with the previous secret gone, every one of them still works', async ({ browser }) => {
      await restartWeb(ROTATED, null);

      // SMTP: mailpit refuses a wrong password, so a delivered message proves it decrypted.
      await deleteAllMail();
      const page = await adminPage(browser);
      await page.goto('/settings/email');
      await waitForHydration(page);
      await page.getByRole('textbox', { name: /send a test message to/i }).fill('rot@example.com');
      await page.getByRole('button', { name: /^send test email$/i }).click();
      await expect(page.getByText(/test message sent to rot@example.com/i)).toBeVisible({
        timeout: 20_000,
      });
      await waitForMail('rot@example.com');
      await page.context().close();

      // OAuth: Keycloak checks the client secret at the token exchange.
      const kcBrowser = await launchKeycloakBrowser();
      try {
        const ctx = await newSignedOutContext(kcBrowser);
        const user = await ctx.newPage();
        await signInThroughKeycloak(user, BASE, providerName);
        await user.goto(`${BASE}/profile`);
        await expect(user.getByText(KC_USER.email).first()).toBeVisible({ timeout: 15_000 });
      } finally {
        await kcBrowser.close();
      }

      // DNS: nothing here calls Cloudflare, so the stored value is read back under the new key.
      expect(decryptUnderSecret(readStored().dnsToken, ROTATED)).toBe(DNS_TOKEN);
    });
  });
