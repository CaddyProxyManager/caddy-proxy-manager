/** Inspects source rather than rendering, to avoid a jsdom environment. */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

const BANNER_PATH = resolve(
  moduleDir,
  '../../../src/components/l4-proxy-hosts/L4PortsApplyBanner.tsx',
);
const banner = readFileSync(BANNER_PATH, 'utf-8');

const CLIENT_PATH = resolve(
  moduleDir,
  '../../../src/app/(dashboard)/l4-proxy-hosts/L4ProxyHostsClient.tsx',
);
const client = readFileSync(CLIENT_PATH, 'utf-8');

describe('L4PortsApplyBanner', () => {
  it('accepts a refreshSignal prop', () => {
    expect(banner).toContain('refreshSignal');
  });

  it('re-fetches when refreshSignal changes via useEffect', () => {
    expect(banner).toMatch(/useEffect\s*\(\s*\(\s*\)\s*=>/);
    expect(banner).toContain('refreshSignal');
    expect(banner).toContain('fetchStatus');
  });

  it('skips fetch when refreshSignal is falsy (avoids double-fetch on mount)', () => {
    // So the mount effect and the signal effect don't both fire on load.
    expect(banner).toMatch(/if\s*\(!\s*refreshSignal\s*\)/);
  });
});

describe('L4ProxyHostsClient banner integration', () => {
  it('tracks bannerRefresh state', () => {
    expect(client).toContain('bannerRefresh');
    expect(client).toContain('setBannerRefresh');
  });

  it('passes refreshSignal to L4PortsApplyBanner', () => {
    expect(client).toContain('refreshSignal={bannerRefresh}');
  });

  it('increments bannerRefresh after toggle', () => {
    expect(client).toMatch(/toggleL4ProxyHostAction[\s\S]{0,200}signalBannerRefresh/);
  });

  it('increments bannerRefresh when create dialog closes', () => {
    expect(client).toMatch(/CreateL4HostDialog[\s\S]{0,400}signalBannerRefresh/);
  });

  it('increments bannerRefresh when edit dialog closes', () => {
    expect(client).toMatch(/EditL4HostDialog[\s\S]{0,400}signalBannerRefresh/);
  });

  it('increments bannerRefresh when delete dialog closes', () => {
    expect(client).toMatch(/DeleteL4HostDialog[\s\S]{0,400}signalBannerRefresh/);
  });

  it('defines signalBannerRefresh as a function that increments the counter', () => {
    // The functional form avoids a stale closure.
    expect(client).toMatch(/signalBannerRefresh\s*=\s*\(\s*\)\s*=>\s*setBannerRefresh\s*\(/);
    expect(client).toContain('n + 1');
  });
});
