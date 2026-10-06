/** Functional e2e helpers; each takes a Page pre-authenticated by the global storageState. */
import { expect, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { injectFormFields, turnOffForceHttps } from './http';

/** The list puts the busiest first, so a host just made, with no traffic, can sit past page one. */
export const PROXY_HOSTS_NEWEST_FIRST = '/proxy-hosts?sortBy=createdAt&sortDir=desc';

export interface ProxyHostConfig {
  name: string;
  domain: string;
  upstream: string; // e.g. "echo-server:8080"
  accessListName?: string; // name of an existing access list to attach
  certificateName?: string;
  mtlsCaNames?: string[];
  mtlsProtectedPaths?: string[];
  mtlsExcludedPaths?: string[];
  enableWaf?: boolean; // enable WAF with OWASP CRS in blocking mode
  wafMode?: 'merge' | 'override';
  wafLoadOwaspCrs?: boolean;
  wafCustomDirectives?: string;
}

export interface ImportedCertificateConfig {
  name: string;
  domains: string[];
  certificatePem: string;
  privateKeyPem: string;
}

export interface GeneratedCaConfig {
  name: string;
  commonName?: string;
  validityDays?: number;
}

export interface IssuedClientCertificateConfig {
  caName: string;
  commonName: string;
  exportPassword: string;
  validityDays?: number;
}

async function openCertificatesTab(page: Page, tabName: RegExp): Promise<void> {
  await page.goto('/certificates');
  await page.getByRole('button', { name: tabName }).click();
}

async function expandCaRow(page: Page, caName: string): Promise<void> {
  const row = page.locator('tr').filter({ hasText: caName }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.locator('button').first().click();
  // The closed "Manage" <dialog> stays in the DOM with the same phrase; visible narrows it.
  await expect(
    page.getByText('Issued Client Certificates', { exact: true }).filter({ visible: true }),
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * Retries the click: one landing before hydration is swallowed, and with every earlier spec's
 * hosts on the page, CI hydrates slowly enough to hit that.
 */
export async function openCreateHostDialog(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    // The dialog opens once its pickers' options are read, a round trip after the click.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 30_000 });
}

/** Force HTTPS is always off so functional tests can use plain HTTP. */
export async function createProxyHost(page: Page, config: ProxyHostConfig): Promise<void> {
  await page.goto(PROXY_HOSTS_NEWEST_FIRST);
  await openCreateHostDialog(page);

  await page.getByLabel('Name').fill(config.name);
  await page.getByLabel(/^domains/i).fill(config.domain);

  const upstreamList = config.upstream
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);
  await page
    .getByPlaceholder('10.0.0.5:8080')
    .first()
    .fill(upstreamList[0] ?? '');
  for (let i = 1; i < upstreamList.length; i++) {
    await page.getByRole('button', { name: /add upstream/i }).click();
    await page.getByPlaceholder('10.0.0.5:8080').nth(i).fill(upstreamList[i]);
  }

  if (config.certificateName) {
    const certTrigger = page.getByRole('combobox', { name: /certificate/i });
    await certTrigger.scrollIntoViewIfNeeded();
    await certTrigger.click();
    const certOption = page.getByRole('option', { name: config.certificateName, exact: true });
    await expect(certOption).toBeVisible({ timeout: 5_000 });
    await certOption.click();
  }

  if (config.accessListName) {
    const accessListTrigger = page.getByRole('combobox', { name: /access list/i });
    await accessListTrigger.scrollIntoViewIfNeeded();
    await accessListTrigger.click();
    const option = page.getByRole('option', { name: config.accessListName });
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();
  }

  if (config.mtlsCaNames?.length) {
    const mtlsCard = page.locator('input[name="mtlsEnabled"]').locator('..');
    await mtlsCard.scrollIntoViewIfNeeded();
    await mtlsCard.getByRole('switch').click();

    await expect(page.getByText(/trusted certificates/i)).toBeVisible({ timeout: 10_000 });

    for (const caName of config.mtlsCaNames) {
      const caLabel = page.locator('label').filter({ hasText: caName });
      await caLabel.scrollIntoViewIfNeeded();
      await caLabel.click();
    }
    const certInputs = page.locator('input[name="mtlsCertId"]');
    await expect(certInputs.first()).toBeAttached({ timeout: 5_000 });

    if (config.mtlsProtectedPaths?.length) {
      await page.locator('[name="mtlsProtectedPaths"]').fill(config.mtlsProtectedPaths.join(', '));
    }

    if (config.mtlsExcludedPaths?.length) {
      await page.locator('[name="mtlsExcludedPaths"]').fill(config.mtlsExcludedPaths.join(', '));
    }
  }

  await turnOffForceHttps(page);
  const extraFields: Record<string, string> = {};

  if (config.enableWaf) {
    Object.assign(extraFields, {
      wafPresent: 'on',
      wafEnabled: 'on',
      wafEngineMode: 'On', // the host form only accepts On/Off
      wafLoadOwaspCrs: config.wafLoadOwaspCrs === false ? '' : 'on',
      wafMode: config.wafMode ?? 'override',
      wafCustomDirectives: config.wafCustomDirectives ?? '',
    });
  }

  await injectFormFields(page, extraFields);

  await page.getByRole('button', { name: /^create$/i }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('table').getByText(config.name, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

export async function importCertificate(
  page: Page,
  config: ImportedCertificateConfig,
): Promise<void> {
  await openCertificatesTab(page, /^Imported/i);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^import certificate$/i })).toBeVisible();

  await page.getByRole('textbox', { name: /^Name/ }).fill(config.name);
  await page.getByLabel(/domains \(one per line\)/i).fill(config.domains.join('\n'));
  await page.locator('[name="certificate_pem"]').fill(config.certificatePem);
  await page.getByRole('button', { name: /show private key/i }).click();
  await page.locator('[name="private_key_pem"]').fill(config.privateKeyPem);
  // The page-level trigger behind the sheet carries the same label.
  await page.locator('button[form="import-cert-form"]').click();

  await expect(page.getByRole('heading', { name: /^import certificate$/i })).not.toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(500); // allow page to revalidate
  await expect(page.locator('table').getByText(config.name, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
}

export async function generateCaCertificate(page: Page, config: GeneratedCaConfig): Promise<void> {
  await openCertificatesTab(page, /^CA \/ mTLS/i);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^add ca certificate$/i })).toBeVisible();

  await page.getByRole('textbox', { name: /^Name/ }).fill(config.name);
  if (config.commonName) {
    await page
      .getByRole('textbox', { name: 'Common Name (CN)', exact: true })
      .fill(config.commonName);
  }
  if (config.validityDays !== undefined) {
    await page
      .getByRole('spinbutton', { name: 'Validity', exact: true })
      .fill(String(config.validityDays));
  }

  await page.getByRole('button', { name: /generate ca certificate/i }).click();
  await expect(page.getByRole('heading', { name: /^add ca certificate$/i })).not.toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('table').getByText(config.name, { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
}

export async function issueClientCertificate(
  page: Page,
  config: IssuedClientCertificateConfig,
): Promise<Buffer> {
  await openCertificatesTab(page, /^CA \/ mTLS/i);
  await expandCaRow(page, config.caName);
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  // Every CA row mounts a dialog that stays in the DOM closed; getByLabel would not skip them.
  const dialog = page.getByRole('dialog', { name: /issue client certificate/i });
  await expect(dialog).toBeVisible();

  // Required fields' accessible names end in "Required", so match the prefix.
  await dialog.getByRole('textbox', { name: /^Common Name \(CN\)/ }).fill(config.commonName);
  if (config.validityDays !== undefined) {
    await dialog.getByRole('spinbutton', { name: /^Validity/ }).fill(String(config.validityDays));
  }
  await dialog.getByRole('textbox', { name: /^Export Password/ }).fill(config.exportPassword);

  await dialog.getByRole('button', { name: 'Issue', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Download', exact: true })).toBeVisible({
    timeout: 15_000,
  });

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await saveDownload(download);

  await dialog.getByRole('button', { name: /^done$/i }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });

  return readFile(downloadPath);
}

export async function revokeIssuedClientCertificate(
  page: Page,
  caName: string,
  commonName: string,
): Promise<void> {
  await openCertificatesTab(page, /^CA \/ mTLS/i);
  await expandCaRow(page, caName);
  await page.getByRole('button', { name: /^manage$/i }).click();
  const dialog = page.getByRole('dialog', { name: /issued client certificates/i });
  await expect(dialog).toBeVisible();

  const certCard = dialog.locator('.astryx-card').filter({ hasText: commonName });
  await expect(certCard).toBeVisible({ timeout: 10_000 });
  await certCard.getByRole('button', { name: /^revoke$/i }).click();
  // Revoked certs are hidden unless "Show revoked" is on, so the whole card goes.
  await expect(certCard).toHaveCount(0, { timeout: 15_000 });
  await dialog
    .getByRole('button', { name: /^close$/i })
    .first()
    .click();
}

async function saveDownload(download: Download): Promise<string> {
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('Playwright download did not produce a local file path');
  }
  return downloadPath;
}

export interface AccessListUser {
  username: string;
  password: string;
}

export async function createAccessList(
  page: Page,
  name: string,
  users: AccessListUser[],
): Promise<void> {
  await page.goto('/access-lists');

  await page.getByRole('button', { name: /^new$/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  await dialog.getByPlaceholder(/internal.*engineering/i).fill(name);

  if (users.length > 0) {
    await dialog.getByPlaceholder('username').first().fill(users[0].username);
    await dialog.getByPlaceholder('password').first().fill(users[0].password);

    for (let i = 1; i < users.length; i++) {
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await dialog.getByPlaceholder('username').nth(i).fill(users[i].username);
      await dialog.getByPlaceholder('password').nth(i).fill(users[i].password);
    }
  }

  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name }).first()).toBeVisible({ timeout: 10_000 });
}
