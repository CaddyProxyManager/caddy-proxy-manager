/**
 * A host's Status column: which problem wins, how signals logged under a Host header (port and
 * case included) find their host, and the busiest-first order the list pages through.
 */
import { describe, expect, it } from 'bun:test';
import type { TrafficSignal } from '@/src/lib/analytics/signals';
import { serverErrorShareItems, signalItems } from '@/src/lib/attention/providers';
import { sortIdsByRequests } from '@/src/lib/proxy-hosts/list-insights';
import {
  hasServerErrorShare,
  hostProblems,
  hostStatus,
  hostTrafficNames,
  problemsFromAttention,
  signalsByProxyHost,
} from '@/src/lib/proxy-hosts/traffic-status';

const burst = (host: string, ongoing: boolean): TrafficSignal => ({
  kind: 'serverErrorBurst',
  severity: ongoing ? 'critical' : 'warning',
  host,
  from: 0,
  to: 60,
  errors: 20,
  requests: 100,
  share: 0.2,
  ongoing,
});

const HOSTS = [
  {
    id: 1,
    name: 'App',
    domains: ['app.example.com', '*.app.example.com'],
    enabled: true,
    certificateId: null,
  },
  { id: 2, name: 'Git', domains: ['Git.Example.com'], enabled: true, certificateId: null },
  { id: 3, name: 'Off', domains: ['off.example.com'], enabled: false, certificateId: null },
];

describe('hostProblems', () => {
  it('ranks an ongoing burst above an expiring certificate and unusual blocking', () => {
    const problems = hostProblems({
      traffic: { total: 100, serverErrors: 20 },
      signals: [
        burst('app.example.com', true),
        {
          kind: 'blockedConcentration',
          severity: 'info',
          host: 'app.example.com',
          path: '/',
          outcome: 'waf',
          requests: 60,
        },
      ],
      certificateStage: 'expiring',
    });
    expect(problems.map((p) => [p.code, p.severity])).toEqual([
      ['serverErrorBurst', 'critical'],
      ['certificateExpiring', 'warning'],
      ['blockedTraffic', 'info'],
    ]);
  });

  it('reports a high 5xx share only without a burst, and only over enough requests', () => {
    expect(hasServerErrorShare({ total: 19, serverErrors: 19 })).toBe(false);
    expect(hasServerErrorShare({ total: 20, serverErrors: 1 })).toBe(true);
    expect(hasServerErrorShare({ total: 100, serverErrors: 4 })).toBe(false);
    const share = hostProblems({
      traffic: { total: 40, serverErrors: 10 },
      signals: [],
      certificateStage: null,
    });
    expect(share).toEqual([{ code: 'serverErrorShare', severity: 'warning' }]);
    const both = hostProblems({
      traffic: { total: 40, serverErrors: 10 },
      signals: [burst('x', false)],
      certificateStage: null,
    });
    expect(both.map((p) => p.code)).toEqual(['serverErrorBurst']);
  });

  it('makes an expired certificate critical', () => {
    expect(hostProblems({ traffic: null, signals: [], certificateStage: 'expired' })).toEqual([
      { code: 'certificateExpired', severity: 'critical' },
    ]);
  });
});

describe('hostStatus', () => {
  const problem = [{ code: 'serverErrorShare' as const, severity: 'warning' as const }];
  it('says disabled or maintenance before any problem', () => {
    expect(hostStatus({ enabled: false }, problem).state).toBe('disabled');
    expect(hostStatus({ enabled: true, maintenance: { enabled: true } }, problem).state).toBe(
      'maintenance',
    );
  });
  it('is the worst problem, else healthy', () => {
    expect(hostStatus({ enabled: true }, problem)).toEqual({
      state: 'problem',
      problem: problem[0],
    });
    expect(hostStatus({ enabled: true }, [])).toEqual({ state: 'healthy', problem: null });
  });
});

describe('signalsByProxyHost', () => {
  it('finds a host by a logged name with a port or in another case, never through a wildcard', () => {
    const found = signalsByProxyHost(
      [
        burst('APP.example.com:8443', true),
        burst('git.example.com', false),
        burst('a.app.example.com', true),
      ],
      HOSTS,
    );
    expect(found.get(1)).toHaveLength(1);
    expect(found.get(2)).toHaveLength(1);
    expect(found.has(3)).toBe(false);
  });

  it('leaves a fleet-wide spike out', () => {
    const fleet: TrafficSignal = {
      kind: 'mitigationSpike',
      severity: 'warning',
      host: null,
      mitigated: 90,
      baseline: 10,
      ratio: 9,
    };
    expect(signalsByProxyHost([fleet], HOSTS).size).toBe(0);
  });
});

describe('hostTrafficNames', () => {
  it('lowercases, deduplicates and drops wildcards', () => {
    expect(hostTrafficNames(['A.example.com', 'a.example.com', '*.example.com', ' '])).toEqual([
      'a.example.com',
    ]);
  });
});

describe('problemsFromAttention', () => {
  it('reads a host page status off its attention items, worst severity per problem', () => {
    expect(
      problemsFromAttention([
        { code: 'blockedConcentration', severity: 'info' },
        { code: 'mitigationSpike', severity: 'warning' },
        { code: 'serverErrorBurst', severity: 'critical' },
        { code: 'agentOffline', severity: 'warning' },
      ]),
    ).toEqual([
      { code: 'serverErrorBurst', severity: 'critical' },
      { code: 'blockedTraffic', severity: 'warning' },
    ]);
  });
});

describe('signalItems', () => {
  it('links a burst on one host to its page and scopes it to that host', async () => {
    const [found] = await signalItems([burst('app.example.com:443', true)], HOSTS);
    expect(found).toMatchObject({
      code: 'serverErrorBurst',
      severity: 'critical',
      href: '/proxy-hosts/1',
      scope: { proxyHosts: [1] },
      values: { ongoing: 'yes', host: 'app.example.com:443' },
    });
  });

  it('sends a name no host serves to the analytics page, for administrators only', async () => {
    const [found] = await signalItems([burst('stray.example.com', false)], HOSTS);
    expect(found?.href).toBe('/analytics?f=host%3Ais%3Astray.example.com');
    expect(found?.scope).toEqual({ proxyHosts: [] });
  });

  it('keeps a fleet spike for administrators', async () => {
    const [found] = await signalItems(
      [
        {
          kind: 'mitigationSpike',
          severity: 'warning',
          host: null,
          mitigated: 80,
          baseline: 0,
          ratio: null,
        },
      ],
      HOSTS,
    );
    expect(found).toMatchObject({ code: 'mitigationSpikeFleet', scope: {}, values: { ratio: 0 } });
  });
});

describe('serverErrorShareItems', () => {
  it('names enabled hosts over the threshold that no burst already covers', () => {
    const traffic = new Map([
      [1, { total: 100, serverErrors: 10 }],
      [2, { total: 100, serverErrors: 10 }],
      [3, { total: 100, serverErrors: 50 }],
    ]);
    const items = serverErrorShareItems(traffic, HOSTS, new Set([2]));
    expect(items.map((i) => i.id)).toEqual(['error-share:1']);
    expect(items[0]?.values).toMatchObject({ host: 'App', errors: 10, share: 0.1 });
  });
});

describe('sortIdsByRequests', () => {
  const traffic = new Map([
    [1, { total: 5 }],
    [2, { total: 50 }],
    [4, { total: 5 }],
  ]);
  it('puts the busiest first and keeps ties (and silent hosts) in their given order', () => {
    expect(sortIdsByRequests([1, 2, 3, 4], traffic, 'desc')).toEqual([2, 1, 4, 3]);
    expect(sortIdsByRequests([1, 2, 3, 4], traffic, 'asc')).toEqual([3, 1, 4, 2]);
  });
});
