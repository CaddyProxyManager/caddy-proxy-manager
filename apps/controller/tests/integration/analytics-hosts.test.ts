import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';

// getAnalyticsHosts merges configured and observed hosts, flagging the configured ones (#171).
const { allMock, queryDistinctHostsMock } = vi.hoisted(() => ({
  allMock: vi.fn(),
  queryDistinctHostsMock: vi.fn(),
}));
// `.from()` resolves rather than exposing `.all()`, since the query is awaited under PostgreSQL.
const fakeDb = {
  select: vi.fn().mockReturnValue({ from: vi.fn(() => Promise.resolve(allMock())) }),
} as unknown as TestDb;
vi.mock('@/src/lib/db', () => dbModuleMock(() => fakeDb));
vi.mock('@/src/lib/clickhouse/client', () => ({
  queryDistinctHosts: queryDistinctHostsMock,
}));

import { getAnalyticsHosts } from '@/src/lib/analytics-db';

function proxyRows(...domainLists: string[][]) {
  return domainLists.map((domains) => ({ domains: JSON.stringify(domains) }));
}

describe('getAnalyticsHosts', () => {
  beforeEach(() => {
    allMock.mockReset();
    queryDistinctHostsMock.mockReset();
  });

  it('flags configured proxy hosts and leaves traffic-only hosts unconfigured', async () => {
    queryDistinctHostsMock.mockResolvedValue(['app.example.com', 'random.attacker.test']);
    allMock.mockReturnValue(proxyRows(['app.example.com']));

    const hosts = await getAnalyticsHosts();

    expect(hosts).toEqual([
      { host: 'app.example.com', configured: true },
      { host: 'random.attacker.test', configured: false },
    ]);
  });

  it('matches configured domains case-insensitively', async () => {
    queryDistinctHostsMock.mockResolvedValue(['api.example.com']);
    allMock.mockReturnValue(proxyRows(['API.Example.com']));

    const hosts = await getAnalyticsHosts();

    expect(hosts).toEqual([{ host: 'api.example.com', configured: true }]);
  });

  it('includes configured hosts that have no traffic yet', async () => {
    queryDistinctHostsMock.mockResolvedValue([]);
    allMock.mockReturnValue(proxyRows(['fresh.example.com']));

    const hosts = await getAnalyticsHosts();

    expect(hosts).toEqual([{ host: 'fresh.example.com', configured: true }]);
  });

  it('filters out raw IP hosts', async () => {
    queryDistinctHostsMock.mockResolvedValue(['10.0.0.5', '10.0.0.5:8080', 'site.example.com']);
    allMock.mockReturnValue(proxyRows(['site.example.com']));

    const hosts = await getAnalyticsHosts();

    expect(hosts).toEqual([{ host: 'site.example.com', configured: true }]);
  });
});
