/** Each takes the standard `page` fixture, already signed in via the global storageState. */
import { expect, type Page } from '@playwright/test';

export interface L4ProxyHostConfig {
  name: string;
  protocol?: 'tcp' | 'udp';
  listenAddress: string;
  upstream: string; // e.g. "tcp-echo:9000"
  matcherType?: 'none' | 'tls_sni' | 'http_host' | 'proxy_protocol';
  matcherValue?: string; // comma-separated
  tlsTermination?: boolean;
  proxyProtocolReceive?: boolean;
  proxyProtocolVersion?: 'v1' | 'v2';
}

/**
 * Two specs need the same TCP host in either order; a duplicate row would fail createL4ProxyHost's
 * strict-mode table assertion, far from the cause.
 */
export async function ensureL4ProxyHost(page: Page, config: L4ProxyHostConfig): Promise<void> {
  const existing = await page.request.get('/api/v1/l4-proxy-hosts');
  expect(existing.ok(), `GET /api/v1/l4-proxy-hosts failed: ${await existing.text()}`).toBe(true);

  const hosts = (await existing.json()) as Array<{ listenAddress: string }>;
  if (hosts.some((host) => host.listenAddress === config.listenAddress)) return;

  await createL4ProxyHost(page, config);
}

export async function createL4ProxyHost(page: Page, config: L4ProxyHostConfig): Promise<void> {
  await page.goto('/l4-proxy-hosts');
  await page.getByRole('button', { name: /create l4 host/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.getByLabel('Name').fill(config.name);

  if (config.protocol && config.protocol !== 'tcp') {
    await page.getByRole('combobox', { name: 'Protocol' }).first().click();
    await page.getByRole('option', { name: new RegExp(config.protocol, 'i') }).click();
  }

  await page.getByLabel('Listen Address').fill(config.listenAddress);
  await page.getByRole('textbox', { name: /^Upstreams/ }).fill(config.upstream);

  if (config.matcherType && config.matcherType !== 'none') {
    await page.getByLabel('Matcher').click();
    const matcherLabels: Record<string, RegExp> = {
      tls_sni: /tls sni/i,
      http_host: /http host/i,
      proxy_protocol: /proxy protocol/i,
    };
    await page.getByRole('option', { name: matcherLabels[config.matcherType] }).click();

    if (
      config.matcherValue &&
      (config.matcherType === 'tls_sni' || config.matcherType === 'http_host')
    ) {
      await page.getByLabel(/hostnames/i).fill(config.matcherValue);
    }
  }

  if (config.tlsTermination) {
    await page.getByLabel(/tls termination/i).check();
  }

  if (config.proxyProtocolReceive) {
    await page.getByLabel(/accept inbound proxy/i).check();
  }

  if (config.proxyProtocolVersion) {
    await page.getByLabel(/send proxy protocol/i).click();
    await page.getByRole('option', { name: config.proxyProtocolVersion }).click();
  }

  await page.getByRole('button', { name: /^create$/i }).click();

  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });

  await expect(page.getByRole('table').getByText(config.name, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}
