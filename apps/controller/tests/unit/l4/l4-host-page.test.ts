/** An L4 host's page: its line per editor section, its health checks and its header. */
import { describe, expect, it } from 'bun:test';
import type { L4ProxyHost } from '@/src/lib/models/l4-proxy-hosts';
import { l4HealthChecksOf, l4HostHeader } from '@/src/lib/l4/detail-types';
import { L4_EDITOR_SECTIONS } from '@/src/lib/l4/editor-sections';
import { l4SectionSummaries } from '@/src/lib/l4/section-summary';

function host(overrides: Partial<L4ProxyHost> = {}): L4ProxyHost {
  return {
    id: 1,
    uuid: '00000000-0000-4000-8000-000000000001',
    name: 'Postgres',
    description: null,
    tags: [],
    protocol: 'tcp',
    listenAddress: ':5432',
    upstreams: ['10.0.0.1:5432'],
    matcherType: 'none',
    matcherValue: [],
    tlsTermination: false,
    proxyProtocolVersion: null,
    proxyProtocolReceive: false,
    accessListId: null,
    enabled: true,
    meta: null,
    loadBalancer: null,
    dnsResolver: null,
    upstreamDnsResolution: null,
    geoblock: null,
    geoblockMode: 'merge',
    crowdsec: true,
    upstreamPortMode: 'fixed',
    dynamicDns: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type Lookups = Parameters<typeof l4SectionSummaries>[1];
const lookups: Lookups = { accessListName: null, agentNames: [], crowdsecActive: false };
const codes = (h: L4ProxyHost, l = lookups) =>
  Object.fromEntries(l4SectionSummaries(h, l).map((s) => [s.section, s.facts.map((f) => f.code)]));

describe('l4SectionSummaries', () => {
  it('has a line for every editor section, with defaults where nothing is set', () => {
    const summary = l4SectionSummaries(host(), lookups);
    expect(summary.map((s) => s.section)).toEqual([...L4_EDITOR_SECTIONS]);
    expect(summary[0]?.facts[0]).toEqual({
      code: 'listen',
      values: { protocol: 'TCP', address: ':5432' },
    });
    expect(codes(host())).toEqual({
      general: ['listen', 'everyAgent'],
      upstreams: ['upstreams', 'noHealthChecks'],
      protection: ['noProtection'],
    });
  });

  it('names what is configured', () => {
    const configured = host({
      matcherType: 'tls_sni',
      matcherValue: ['db.example.com'],
      tlsTermination: true,
      proxyProtocolVersion: 'v2',
      upstreamPortMode: 'same',
      geoblock: { enabled: true } as L4ProxyHost['geoblock'],
    });
    expect(
      codes(configured, { accessListName: 'Office', agentNames: ['edge'], crowdsecActive: true }),
    ).toEqual({
      general: ['listen', 'matcherSni', 'tlsTerminated', 'pinnedAgents'],
      upstreams: ['upstreams', 'samePortUpstreams', 'proxyProtocolOut', 'noHealthChecks'],
      protection: ['accessList', 'geo', 'crowdsec'],
    });
  });

  it('counts CrowdSec only once it is set up', () => {
    expect(codes(host()).protection).toEqual(['noProtection']);
  });
});

describe('l4HealthChecksOf', () => {
  it('reads checks only from an enabled load balancer', () => {
    const lb = {
      enabled: true,
      policy: 'first',
      policyChoose: null,
      policyWeights: null,
      tryDuration: null,
      tryInterval: null,
      activeHealthCheck: { enabled: true, port: 9000, interval: '10s', timeout: null },
      passiveHealthCheck: { enabled: false, failDuration: null, maxFails: null },
    } as const;
    expect(l4HealthChecksOf(host({ loadBalancer: lb }))).toEqual({
      active: { port: 9000, interval: '10s' },
      passive: null,
    });
    expect(l4HealthChecksOf(host({ loadBalancer: { ...lb, enabled: false } }))).toEqual({
      active: null,
      passive: null,
    });
  });
});

describe('l4HostHeader', () => {
  it('shows the listen address where a proxy host shows its domains', () => {
    expect(l4HostHeader(host())).toMatchObject({ domains: ['TCP :5432'], status: null });
    expect(l4HostHeader(host({ enabled: false })).status).toEqual({
      state: 'disabled',
      problem: null,
    });
  });
});
