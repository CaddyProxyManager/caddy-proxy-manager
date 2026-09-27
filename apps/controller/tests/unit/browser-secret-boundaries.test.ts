import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { toCertificateApiResponse, toCertificatePickerOption } from '@/src/lib/certificate-api';

const certificate = {
  id: 7,
  name: 'Imported',
  type: 'imported' as const,
  domainNames: ['example.com'],
  autoRenew: false,
  providerOptions: {
    provider: 'cloudflare',
    api_token: 'provider-option-secret-sentinel',
  },
  certificatePem: 'public certificate',
  privateKeyPem: 'private-key-secret-sentinel',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('browser secret boundaries', () => {
  it('uses allowlisted certificate API and picker views', () => {
    const api = JSON.stringify(
      toCertificateApiResponse({
        ...certificate,
        futureSecret: 'future-secret-sentinel',
      } as typeof certificate),
    );
    const picker = JSON.stringify(
      toCertificatePickerOption({
        ...certificate,
        futureSecret: 'future-secret-sentinel',
      } as typeof certificate),
    );

    expect(api).toContain('"provider":"cloudflare"');
    expect(api).not.toContain('provider-option-secret-sentinel');
    expect(api).not.toContain('private-key-secret-sentinel');
    expect(api).not.toContain('future-secret-sentinel');
    expect(picker).toBe('{"id":7,"name":"Imported"}');
  });

  it('redacts DNS settings and certificate records before client-component props', () => {
    const settingsPage = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/settings/[section]/page.tsx'),
      'utf8',
    );
    const proxyHostsPage = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/proxy-hosts/page.tsx'),
      'utf8',
    );

    expect(settingsPage).toContain('redactDnsProviderSettingsForApi(dnsProvider)');
    expect(settingsPage).not.toMatch(/dnsProvider=\{dnsProvider\}/);
    expect(proxyHostsPage).toContain('certificates.map(toCertificatePickerOption)');
    expect(proxyHostsPage).not.toMatch(/certificates=\{certificates\}/);
  });

  it('keeps the settings home from handing raw settings blobs to the client', () => {
    // The home reads credential-bearing blobs for tile status; only `sectionHealth`'s names and
    // counts may cross to the client component.
    const homePage = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/settings/page.tsx'),
      'utf8',
    );

    const props = homePage.match(/<SettingsHome([^/]*)\/>/)?.[1] ?? '';
    expect(props).not.toMatch(/dnsProvider|tailscale|acme=|geoip=|analytics=/);
    expect(props).toMatch(/sections=\{sections\}/);
  });

  it("sends the profile page whether a password is set, never the user's hash", () => {
    const profilePage = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/profile/page.tsx'),
      'utf8',
    );
    const profileClient = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/profile/ProfileClient.tsx'),
      'utf8',
    );
    expect(profilePage).not.toMatch(/user=\{user\}/);
    expect(profilePage).toContain('hasPassword: Boolean(user.passwordHash)');
    expect(profileClient).not.toContain('passwordHash');
  });
});
