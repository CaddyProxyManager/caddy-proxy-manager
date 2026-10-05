/**
 * A cloud metadata service hands out the instance's own credentials, so no admin-entered address
 * the controller requests (acme-dns, a CrowdSec LAPI) may point at one, in any spelling.
 */
import { describe, expect, it } from 'bun:test';
import { isMetadataHost, parseOutboundBaseUrl } from '@/src/lib/http/outbound-url';
import { parseAcmeDnsServerUrl } from '@/src/lib/dns/acme-dns';
import { normalizeCrowdSecSettings, probeCrowdSecLapi } from '@/src/lib/caddy/crowdsec';

const METADATA_URLS = [
  'http://169.254.169.254',
  'http://169.254.169.254./latest',
  'http://2852039166',
  'http://0xa9fea9fe',
  'http://169.254.0.1:8080',
  'http://[::ffff:169.254.169.254]',
  'http://[fd00:ec2::254]',
  'http://[fe80::1]',
  'http://100.100.100.200',
  'https://metadata.google.internal',
  'https://METADATA.google.internal.',
  'https://metadata.goog',
];

describe('cloud metadata addresses', () => {
  it.each(METADATA_URLS)('refuses %s', (url) => {
    expect(parseOutboundBaseUrl(url)).toEqual({ problem: 'metadata' });
  });

  it.each([
    'http://crowdsec:8080',
    'http://10.0.0.4:8080',
    'http://192.168.1.10',
    'http://100.64.0.1',
    'http://[fd00::1]',
    'https://auth.example.org',
    'https://metadata.example.com',
  ])('lets %s through', (url) => {
    expect(parseOutboundBaseUrl(url).problem).toBeUndefined();
  });

  it('is told apart from an ordinary host by its name and address alone', () => {
    expect(isMetadataHost('[::ffff:a9fe:a9fe]')).toBe(true);
    expect(isMetadataHost('[::ffff:a00:4]')).toBe(false);
    expect(isMetadataHost('metadata')).toBe(false);
  });

  it('is refused where acme-dns and CrowdSec addresses are saved', () => {
    expect(() => parseAcmeDnsServerUrl('http://169.254.169.254')).toThrow(
      expect.objectContaining({ code: 'outboundUrlMetadata' }),
    );
    expect(() => normalizeCrowdSecSettings({ apiUrl: 'http://169.254.169.254' })).toThrow(
      expect.objectContaining({ code: 'outboundUrlMetadata' }),
    );
    expect(() => normalizeCrowdSecSettings({ appsecUrl: 'http://[fd00:ec2::254]:7422' })).toThrow(
      expect.objectContaining({ code: 'outboundUrlMetadata' }),
    );
  });

  it('is never requested by the CrowdSec connection test', async () => {
    let requests = 0;
    const impl = (async () => {
      requests++;
      return Response.json(null);
    }) as unknown as typeof fetch;
    expect(await probeCrowdSecLapi('http://169.254.169.254', 'k3y', impl)).toEqual({
      status: 'unreachable',
    });
    expect(requests).toBe(0);
  });
});
