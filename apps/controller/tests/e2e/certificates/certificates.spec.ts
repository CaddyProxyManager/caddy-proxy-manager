import { test, expect } from '@playwright/test';
import { createSelfSignedServerCertificate } from '../../helpers/certs';
import { waitForHydration } from '../../helpers/hydration';

test.describe('Certificates', () => {
  test('page loads with tabs visible', async ({ page }) => {
    await page.goto('/certificates');
    await expect(page).not.toHaveURL(/error|login/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('certificates page has certificate management UI', async ({ page }) => {
    await page.goto('/certificates');
    await expect(page.locator('body')).toBeVisible();
    const hasAddButton = (await page.getByRole('button', { name: /add|new|create/i }).count()) > 0;
    const hasTab = (await page.getByRole('button').count()) > 0;
    expect(hasAddButton || hasTab).toBe(true);
  });

  test('navigating to certificates does not redirect to login', async ({ page }) => {
    await page.goto('/certificates');
    await expect(page).not.toHaveURL(/login/);
  });

  test('wildcard cert covers subdomain - no duplicate in ACME tab', async ({ page }) => {
    const BASE_URL = 'http://localhost:3000';
    const API = `${BASE_URL}/api/v1`;
    const headers = { 'Content-Type': 'application/json', Origin: BASE_URL };
    const domain = `wc-test-${Date.now()}.example`;

    const certRes = await page.request.post(`${API}/certificates`, {
      data: {
        name: `Wildcard ${domain}`,
        type: 'managed',
        domainNames: [domain, `*.${domain}`],
        autoRenew: true,
      },
      headers,
    });
    expect(certRes.status()).toBe(201);
    const cert = await certRes.json();

    // No certificateId, so auto ACME.
    const hostRes = await page.request.post(`${API}/proxy-hosts`, {
      data: {
        name: `Sub ${domain}`,
        domains: [`sub.${domain}`],
        upstreams: ['127.0.0.1:8080'],
      },
      headers,
    });
    expect(hostRes.status()).toBe(201);
    const host = await hostRes.json();

    try {
      await page.goto('/certificates');
      await expect(
        page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: /acme/i }),
      ).toBeVisible();
      await page
        .getByRole('navigation', { name: 'Tabs' })
        .getByRole('button', { name: /acme/i })
        .click();

      const acmeTab = page.getByRole('main');
      await expect(acmeTab.getByText(`sub.${domain}`)).not.toBeVisible({ timeout: 5_000 });
    } finally {
      await page.request.delete(`${API}/proxy-hosts/${host.id}`, { headers });
      await page.request.delete(`${API}/certificates/${cert.id}`, { headers });
    }
  });

  test('ACME wildcard host hides subdomain ACME hosts in certificates page', async ({ page }) => {
    const BASE_URL = 'http://localhost:3000';
    const API = `${BASE_URL}/api/v1`;
    const headers = { 'Content-Type': 'application/json', Origin: BASE_URL };
    const domain = `acme-wc-${Date.now()}.example`;

    // Wildcards need DNS-01. GET redacts credentials, so teardown clears rather than restores.
    const dnsProviderUrl = `${API}/settings/dns-provider`;
    const setDnsRes = await page.request.put(dnsProviderUrl, {
      data: { providers: { duckdns: { api_token: 'e2e-fake-token' } }, default: 'duckdns' },
      headers,
    });
    expect(setDnsRes.ok()).toBeTruthy();

    let wcHostId: number | undefined;
    let subHostId: number | undefined;
    try {
      const wcHostRes = await page.request.post(`${API}/proxy-hosts`, {
        data: {
          name: `Wildcard ${domain}`,
          domains: [`*.${domain}`],
          upstreams: ['127.0.0.1:8080'],
        },
        headers,
      });
      expect(wcHostRes.status()).toBe(201);
      wcHostId = (await wcHostRes.json()).id;

      const subHostRes = await page.request.post(`${API}/proxy-hosts`, {
        data: {
          name: `Sub ${domain}`,
          domains: [`sub.${domain}`],
          upstreams: ['127.0.0.1:8080'],
        },
        headers,
      });
      expect(subHostRes.status()).toBe(201);
      subHostId = (await subHostRes.json()).id;

      await page.goto('/certificates');
      await expect(
        page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: /acme/i }),
      ).toBeVisible();
      await page
        .getByRole('navigation', { name: 'Tabs' })
        .getByRole('button', { name: /acme/i })
        .click();

      const acmeTab = page.getByRole('main');
      // The domain also sits in the hidden mobile card and the row's closed tooltip.
      const acmeTable = acmeTab.getByRole('table');
      await expect(acmeTable.getByText(`*.${domain}`)).toBeVisible({ timeout: 5_000 });
      await expect(acmeTable.getByText(`sub.${domain}`)).not.toBeVisible({ timeout: 5_000 });
    } finally {
      if (subHostId) await page.request.delete(`${API}/proxy-hosts/${subHostId}`, { headers });
      if (wcHostId) await page.request.delete(`${API}/proxy-hosts/${wcHostId}`, { headers });
      await page.request.put(dnsProviderUrl, {
        data: { providers: {}, default: null },
        headers,
      });
    }
  });

  test('deletes an imported certificate from the Imported tab (#151)', async ({ page }) => {
    const BASE_URL = 'http://localhost:3000';
    const API = `${BASE_URL}/api/v1`;
    const headers = { 'Content-Type': 'application/json', Origin: BASE_URL };
    const domain = `import-delete-${Date.now()}.example`;
    const certName = `Imported Delete ${domain}`;
    const { certificatePem, privateKeyPem } = createSelfSignedServerCertificate(domain, [domain]);

    const certRes = await page.request.post(`${API}/certificates`, {
      data: {
        name: certName,
        type: 'imported',
        domainNames: [domain],
        autoRenew: false,
        certificatePem,
        privateKeyPem,
      },
      headers,
    });
    expect(certRes.status()).toBe(201);
    const cert = (await certRes.json()) as { id: number };

    try {
      await page.goto('/certificates');
      await waitForHydration(page);
      await page
        .getByRole('navigation', { name: 'Tabs' })
        .getByRole('button', { name: /imported/i })
        .click();

      await expect(page.getByText(certName, { exact: true }).last()).toBeVisible({
        timeout: 10_000,
      });

      await page
        .getByRole('button', { name: `Actions for certificate ${certName}` })
        .last()
        .click();
      await page.getByRole('menuitem', { name: /^delete$/i }).click();

      const dialog = page.getByRole('alertdialog', { name: /delete imported certificate/i });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: /delete certificate/i }).click();

      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      // The row renders twice (mobile card, desktop row); strict visibility flakes mid-revalidate.
      await expect(page.getByText(certName)).toHaveCount(0, { timeout: 10_000 });

      const getRes = await page.request.get(`${API}/certificates/${cert.id}`, {
        headers: { Origin: BASE_URL },
      });
      expect(getRes.status()).toBe(404);
    } finally {
      await page.request
        .delete(`${API}/certificates/${cert.id}`, { headers })
        .catch(() => undefined);
    }
  });

  test('imports a multiline private key without exposing it through the API (#157)', async ({
    page,
  }) => {
    const BASE_URL = 'http://localhost:3000';
    const API = `${BASE_URL}/api/v1`;
    const headers = { 'Content-Type': 'application/json', Origin: BASE_URL };
    const domain = `import-ui-${Date.now()}.example`;
    const certName = `UI Import ${domain}`;
    const { certificatePem, privateKeyPem } = createSelfSignedServerCertificate(domain, [domain]);
    // Textareas normalize CRLF to LF.
    const normalizedPrivateKeyPem = privateKeyPem.replace(/\r\n?/g, '\n');

    // Otherwise newline preservation goes untested.
    expect(privateKeyPem.split('\n').length).toBeGreaterThan(3);

    let createdId: number | null = null;
    try {
      await page.goto('/certificates');
      await waitForHydration(page);
      await page
        .getByRole('navigation', { name: 'Tabs' })
        .getByRole('button', { name: /imported/i })
        .click();

      await page.getByRole('button', { name: 'Import', exact: true }).first().click();

      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();

      await drawer.getByLabel(/^name/i).fill(certName);
      await drawer.getByLabel(/^domains/i).fill(domain);

      await drawer.getByLabel(/certificate pem/i).fill(certificatePem);

      // Regression (#157): pasted while masked; a password input strips the PEM's newlines.
      const keyField = drawer.getByLabel(/private key pem/i);
      await keyField.click();
      await keyField.fill(privateKeyPem);
      expect(await keyField.evaluate((element) => element.tagName)).toBe('TEXTAREA');
      expect(await keyField.inputValue()).toBe(normalizedPrivateKeyPem);

      await drawer.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(drawer).not.toBeVisible({ timeout: 10_000 });

      // The API confirms a key is stored but must never return it.
      const listRes = await page.request.get(`${API}/certificates`, {
        headers: { Origin: BASE_URL },
      });
      expect(listRes.ok()).toBe(true);
      const listBody = await listRes.text();
      const list = JSON.parse(listBody) as Array<{
        id: number;
        name: string;
        hasPrivateKey: boolean;
      }>;
      const created = list.find((c) => c.name === certName);
      expect(created).toBeTruthy();
      createdId = created!.id;
      expect(created!.hasPrivateKey).toBe(true);
      expect(created).not.toHaveProperty('privateKeyPem');
      expect(listBody).not.toContain(normalizedPrivateKeyPem.split('\n')[1]);
    } finally {
      if (createdId !== null) {
        await page.request
          .delete(`${API}/certificates/${createdId}`, { headers })
          .catch(() => undefined);
      }
    }
  });
});
