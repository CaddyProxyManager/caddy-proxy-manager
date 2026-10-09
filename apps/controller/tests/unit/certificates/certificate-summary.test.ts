import { describe, expect, it } from 'bun:test';

import {
  countExpiry,
  countHealthyAcmeHosts,
} from '@/src/app/(dashboard)/certificates/certificate-summary';

describe('certificate summary helpers', () => {
  it('counts imported expiry buckets', () => {
    expect(countExpiry(['ok', 'expired', 'expiring_soon', null, 'ok'])).toEqual({
      expired: 1,
      expiringSoon: 1,
      healthy: 2,
    });
  });

  it('counts healthy ACME hosts from the full deduplicated set', () => {
    const allAcmeHosts = Array.from({ length: 28 }, (_, index) => ({
      id: index + 1,
      uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `host-${index + 1}`,
      domains: [`host-${index + 1}.example.com`],
      sslForced: true,
      enabled: index < 28,
    }));

    const paginatedAcmeHosts = allAcmeHosts.slice(0, 25);

    expect(countHealthyAcmeHosts(allAcmeHosts)).toBe(28);
    expect(countHealthyAcmeHosts(paginatedAcmeHosts)).toBe(25);
  });
});
