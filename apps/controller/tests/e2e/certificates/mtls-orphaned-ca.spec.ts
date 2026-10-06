import { test, expect } from '@playwright/test';

const API_CA = 'http://localhost:3000/api/v1/ca-certificates';
const API_CLIENT_CERTS = 'http://localhost:3000/api/v1/client-certificates';

// Never attached to a host, so never in the Caddy config.
const FAKE_PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIBfake\n-----END PRIVATE KEY-----';

/**
 * Regression: deleting a CA must also remove the certs it issued. The schema declares
 * onDelete: "cascade", but bun:sqlite leaves PRAGMA foreign_keys OFF, so orphans lingered.
 */
test.describe('mTLS - deleted CA must not remain selectable', () => {
  test('issued certs of a deleted CA disappear from the mTLS picker', async ({ page }) => {
    await page.goto('/proxy-hosts');
    const origin = new URL(page.url()).origin;

    const caName = 'Orphan Test CA';
    const certCommonName = 'orphan-test-device';

    // 1. Create a CA.
    const caResp = await page.request.post(API_CA, {
      headers: { Origin: origin },
      data: { name: caName, certificatePem: FAKE_PEM, privateKeyPem: FAKE_KEY },
    });
    expect(caResp.ok()).toBeTruthy();
    const ca = (await caResp.json()) as { id: number };

    // 2. Issue a client certificate from that CA.
    const certResp = await page.request.post(API_CLIENT_CERTS, {
      headers: { Origin: origin },
      data: {
        caCertificateId: ca.id,
        commonName: certCommonName,
        serialNumber: 'ORPHAN01',
        fingerprintSha256:
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        certificatePem: FAKE_PEM,
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2030-01-01T00:00:00Z',
      },
    });
    expect(certResp.ok()).toBeTruthy();
    const cert = (await certResp.json()) as { id: number };

    let caDeleted = false;
    try {
      // 3. The issued cert is selectable in a host's mTLS picker.
      await page.reload();
      await openMtlsPicker(page);
      const dialog = page.getByRole('dialog');
      // By control: both names appear more than once as text.
      await expect(dialog.getByRole('checkbox', { name: caName })).toBeVisible({ timeout: 10000 });
      await expect(dialog.getByRole('checkbox', { name: certCommonName })).toBeVisible();
      await dialog
        .getByRole('button', { name: /cancel|close/i })
        .first()
        .click();
      await expect(dialog).not.toBeVisible({ timeout: 10000 });

      // 4. Delete the CA. This must cascade to its issued certificates.
      const delResp = await page.request.delete(`${API_CA}/${ca.id}`, {
        headers: { Origin: origin },
      });
      expect(delResp.ok()).toBeTruthy();
      caDeleted = true;

      // Gone from the API too: a real cascade.
      const certAfter = await page.request.get(`${API_CLIENT_CERTS}/${cert.id}`);
      expect(certAfter.status()).toBe(404);

      // 5. The CA and its cert must no longer appear in the mTLS picker.
      await page.reload();
      await openMtlsPicker(page);
      const dialog2 = page.getByRole('dialog');
      await expect(dialog2.getByText(certCommonName)).toHaveCount(0);
      await expect(dialog2.getByText(caName)).toHaveCount(0);
    } finally {
      if (!caDeleted) {
        await page.request.delete(`${API_CA}/${ca.id}`, { headers: { Origin: origin } });
      }
    }
  });
});

/** The picker renders only once the mTLS section is enabled. */
async function openMtlsPicker(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const mtlsCard = dialog.locator('div:has(> input[name="mtlsPresent"])');
  await mtlsCard.scrollIntoViewIfNeeded();
  const mtlsSwitch = mtlsCard.getByRole('switch').first();
  await mtlsSwitch.click();
  await expect(mtlsSwitch).toBeChecked();
}
