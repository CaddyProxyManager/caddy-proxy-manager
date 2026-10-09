/** Wildcard certs need ACME DNS-01, so an auto-managed wildcard host needs a DNS provider. */
import { test, expect } from '@playwright/test';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const API_DNS_PROVIDER = 'http://localhost:3000/api/v1/settings/dns-provider';

test.describe('Wildcard host DNS-provider guard', () => {
  test('rejects auto-managed wildcard without a DNS provider, allows it once configured', async ({
    page,
  }) => {
    await page.goto('/proxy-hosts');
    const origin = new URL(page.url()).origin;
    const headers = { Origin: origin };

    const createdIds: string[] = [];
    try {
      // ── No DNS provider configured ──────────────────────────────────────
      const clearResp = await page.request.put(API_DNS_PROVIDER, {
        headers,
        data: { providers: {}, default: null },
      });
      expect(clearResp.ok()).toBeTruthy();

      const rejected = await page.request.post(API_PROXY_HOSTS, {
        headers,
        data: {
          name: 'Wildcard Guard',
          domains: ['*.e2e-wildcard.test'],
          upstreams: ['localhost:9999'],
        },
      });
      expect(rejected.status()).toBe(400);
      expect((await rejected.json()).error).toMatch(/DNS provider/i);

      // Control: an exact-domain host is unaffected by the guard.
      const okExact = await page.request.post(API_PROXY_HOSTS, {
        headers,
        data: {
          name: 'Exact Guard',
          domains: ['exact.e2e-wildcard.test'],
          upstreams: ['localhost:9999'],
        },
      });
      expect(okExact.ok()).toBeTruthy();
      createdIds.push((await okExact.json()).uuid);

      // ── DNS provider configured ─────────────────────────────────────────
      const setResp = await page.request.put(API_DNS_PROVIDER, {
        headers,
        data: { providers: { duckdns: { api_token: 'e2e-fake-token' } }, default: 'duckdns' },
      });
      expect(setResp.ok()).toBeTruthy();

      const statusResp = await page.request.get(API_DNS_PROVIDER);
      expect(statusResp.ok()).toBeTruthy();
      const statusBody = await statusResp.text();
      expect(JSON.parse(statusBody)).toEqual({
        providers: { duckdns: { configuredFields: ['api_token'] } },
        default: 'duckdns',
        delegations: [],
        acmeDnsAccounts: {},
      });
      expect(statusBody).not.toContain('e2e-fake-token');

      const allowed = await page.request.post(API_PROXY_HOSTS, {
        headers,
        data: {
          name: 'Wildcard Allowed',
          domains: ['*.e2e-wildcard.test'],
          upstreams: ['localhost:9999'],
        },
      });
      expect(allowed.ok()).toBeTruthy();
      createdIds.push((await allowed.json()).uuid);
    } finally {
      for (const id of createdIds) {
        await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers });
      }
      // GET redacts credentials, so the prior configuration cannot be restored.
      await page.request.put(API_DNS_PROVIDER, {
        headers,
        data: { providers: {}, default: null },
      });
    }
  });
});
