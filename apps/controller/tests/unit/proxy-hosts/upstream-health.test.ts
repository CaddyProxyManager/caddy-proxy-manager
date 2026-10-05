import { describe, expect, it } from 'bun:test';
import {
  type AgentUpstreams,
  decodeCaddyUpstreams,
  hostHealthChecks,
  summarizeUpstreamHealth,
} from '../../../src/lib/proxy-hosts/upstream-health-summary';
import {
  duplicateL4ProxyHostDraft,
  duplicateProxyHostDraft,
} from '../../../src/lib/proxy-hosts/duplicate';
import type { ProxyHost } from '../../../src/lib/models/proxy-hosts';
import type { L4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';

const UPSTREAMS = [
  { upstream: 'http://app-1:8080', dials: ['app-1:8080'] },
  { upstream: 'http://app-2:8080', dials: ['app-2:8080'] },
];

function summarize(answers: AgentUpstreams[], healthChecks = true, maxFails = 2) {
  return summarizeUpstreamHealth({
    hostId: 7,
    upstreams: UPSTREAMS,
    healthChecks,
    maxFails,
    answers,
    checkedAt: '2026-10-05T00:00:00.000Z',
  });
}

describe('decodeCaddyUpstreams', () => {
  it("reads Caddy's answer and drops malformed entries", () => {
    expect(
      decodeCaddyUpstreams(
        JSON.stringify([
          { address: 'app-1:8080', num_requests: 3, fails: 0 },
          { address: 'app-2:8080', num_requests: -1, fails: 2 },
          { fails: 9 },
          'junk',
        ]),
      ),
    ).toEqual([
      { address: 'app-1:8080', requests: 3, fails: 0 },
      { address: 'app-2:8080', requests: 0, fails: 2 },
    ]);
  });

  it('is null for an answer that is not a list', () => {
    expect(decodeCaddyUpstreams('not json')).toBeNull();
    expect(decodeCaddyUpstreams('{"address":"x"}')).toBeNull();
  });
});

describe('summarizeUpstreamHealth', () => {
  it('reports healthy, failing and not reported from one agent', () => {
    const health = summarize([
      {
        agentId: 1,
        name: 'edge',
        entries: [{ address: 'app-2:8080', requests: 5, fails: 1 }],
      },
    ]);
    expect(health.upstreams.map((u) => u.state)).toEqual(['unreported', 'failing']);
    expect(health.upstreams[1]).toMatchObject({ fails: 1, outOfRotation: false, requests: 5 });
  });

  it('marks an upstream at max fails as out of rotation', () => {
    const health = summarize([
      {
        agentId: 1,
        name: 'edge',
        entries: [
          { address: 'app-1:8080', requests: 1, fails: 0 },
          { address: 'app-2:8080', requests: 0, fails: 2 },
        ],
      },
    ]);
    expect(health.upstreams.map((u) => [u.state, u.outOfRotation])).toEqual([
      ['healthy', false],
      ['failing', true],
    ]);
  });

  it('says not checked when the host has no health checks, whatever Caddy counts', () => {
    const health = summarize(
      [{ agentId: 1, name: 'edge', entries: [{ address: 'app-1:8080', requests: 1, fails: 4 }] }],
      false,
    );
    expect(health.upstreams[0]).toMatchObject({
      state: 'unchecked',
      fails: 0,
      outOfRotation: false,
    });
  });

  it('never reads a silent agent as a failure', () => {
    const health = summarize([{ agentId: 1, name: 'edge', entries: null }]);
    expect(health.upstreams.map((u) => u.state)).toEqual(['unknown', 'unknown']);
    expect(health.agents).toEqual([{ agentId: 1, name: 'edge', reachable: false }]);
  });

  it('merges agents: one failing wins, and silence does not hide the others', () => {
    const health = summarize([
      { agentId: 1, name: 'fra', entries: [{ address: 'app-1:8080', requests: 2, fails: 0 }] },
      { agentId: 2, name: 'ams', entries: [{ address: 'app-1:8080', requests: 3, fails: 1 }] },
      { agentId: 3, name: 'lab', entries: null },
    ]);
    const first = health.upstreams[0];
    expect(first.state).toBe('failing');
    expect(first.requests).toBe(5);
    expect(first.agents.map((a) => [a.name, a.state])).toEqual([
      ['fra', 'healthy'],
      ['ams', 'failing'],
      ['lab', 'unknown'],
    ]);
  });

  it('adds up an upstream DNS pinning expanded into several addresses', () => {
    const health = summarizeUpstreamHealth({
      hostId: 1,
      upstreams: [{ upstream: 'http://app:80', dials: ['app:80', '10.0.0.1:80', '10.0.0.2:80'] }],
      healthChecks: true,
      maxFails: 1,
      answers: [
        {
          agentId: null,
          name: null,
          entries: [
            { address: '10.0.0.1:80', requests: 2, fails: 0 },
            { address: '10.0.0.2:80', requests: 1, fails: 1 },
          ],
        },
      ],
    });
    expect(health.upstreams[0]).toMatchObject({
      state: 'failing',
      requests: 3,
      outOfRotation: true,
    });
  });
});

describe('hostHealthChecks', () => {
  const lb = (overrides: Record<string, unknown>) =>
    ({
      loadBalancer: {
        enabled: true,
        activeHealthCheck: null,
        passiveHealthCheck: null,
        ...overrides,
      },
    }) as never;

  it('needs load balancing on and a check enabled', () => {
    expect(hostHealthChecks({ loadBalancer: null })).toEqual({ enabled: false, maxFails: 1 });
    expect(hostHealthChecks(lb({}))).toEqual({ enabled: false, maxFails: 1 });
    expect(hostHealthChecks(lb({ activeHealthCheck: { enabled: true } })).enabled).toBe(true);
    expect(hostHealthChecks(lb({ passiveHealthCheck: { enabled: true, maxFails: 3 } }))).toEqual({
      enabled: true,
      maxFails: 3,
    });
    expect(
      hostHealthChecks({
        loadBalancer: { enabled: false, passiveHealthCheck: { enabled: true } },
      } as never).enabled,
    ).toBe(false);
  });
});

describe('duplicate drafts', () => {
  it('clears the domains and the sticky-cookie secret, keeping the rest', () => {
    const host = {
      name: 'app',
      domains: ['app.example.com'],
      upstreams: ['app:80'],
      tags: ['prod'],
      certificateId: 4,
      loadBalancer: { enabled: true, policy: 'cookie', policyCookieSecret: 's3cret' },
    } as unknown as ProxyHost;
    const draft = duplicateProxyHostDraft(host);
    expect(draft.domains).toEqual([]);
    expect(draft.loadBalancer?.policyCookieSecret).toBeNull();
    expect(draft.loadBalancer?.policy).toBe('cookie' as never);
    expect(draft.upstreams).toEqual(['app:80']);
    expect(draft.tags).toEqual(['prod']);
    expect(draft.certificateId).toBe(4);
    expect(host.loadBalancer?.policyCookieSecret).toBe('s3cret');
  });

  it("clears an L4 host's matcher hostnames", () => {
    const host = {
      matcherType: 'tls_sni',
      matcherValue: ['db.example.com'],
    } as unknown as L4ProxyHost;
    expect(duplicateL4ProxyHostDraft(host)).toMatchObject({
      matcherType: 'tls_sni',
      matcherValue: [],
    });
  });
});
