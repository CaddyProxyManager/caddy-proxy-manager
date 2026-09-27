import { beforeEach, describe, expect, it } from 'bun:test';
import {
  RENEW_NOW_WINDOW_RATIO,
  RENEWAL_TIMEOUT_MS,
  renewNowRatio,
  renewalsPending,
  requestRenewal,
  resetRenewals,
  evictedNames,
  settleRenewals,
  withEviction,
  withRenewalOverrides,
} from '../../src/lib/certificate-renewals';
import {
  REACHABILITY_PATH,
  isCheckableDomain,
  reachabilityRoute,
  reachabilityToken,
} from '../../src/lib/domain-reachability';

const acme = { module: 'acme', email: 'ops@example.com' };

const EDGE = 'edge-agent';
const on = (agent = EDGE) => [{ agent }];

beforeEach(() => {
  resetRenewals();
});

describe('withRenewalOverrides', () => {
  it('leaves the policies alone with nothing to renew', () => {
    const policies = [{ subjects: ['a.example.com', 'b.example.com'], issuers: [acme] }];
    expect(withRenewalOverrides(policies, EDGE)).toBe(policies);
  });

  it('splits just the renewing name into a copy of its policy with the wide window', () => {
    requestRenewal('B.example.com', on());
    const result = withRenewalOverrides(
      [{ subjects: ['a.example.com', 'b.example.com'], issuers: [acme] }],
      EDGE,
    );
    expect(result).toEqual([
      {
        subjects: ['b.example.com'],
        issuers: [acme],
        renewal_window_ratio: RENEW_NOW_WINDOW_RATIO,
      },
      { subjects: ['a.example.com'], issuers: [acme] },
    ]);
  });

  it('drops a policy the split left empty, rather than let it match everything', () => {
    requestRenewal('only.example.com', on());
    const result = withRenewalOverrides(
      [{ subjects: ['only.example.com'], issuers: [acme] }],
      EDGE,
    );
    expect(result).toHaveLength(1);
    expect(result[0].subjects).toEqual(['only.example.com']);
  });
});

describe('eviction', () => {
  it('leaves the name unmanaged only while the load runs', async () => {
    requestRenewal('e.example.com', on());
    const policies = [
      { subjects: ['e.example.com'], issuers: [acme] },
      { subjects: ['f.example.com'], issuers: [acme] },
    ];
    let during: unknown;
    await withEviction(['E.example.com'], async () => {
      during = withRenewalOverrides(policies, EDGE);
      expect(evictedNames()).toEqual(['e.example.com']);
    });
    // Gone from every policy, so Caddy drops it from its cache - and no empty policy is left behind.
    expect(during).toEqual([{ subjects: ['f.example.com'], issuers: [acme] }]);
    expect(evictedNames()).toEqual([]);
    expect(withRenewalOverrides(policies, EDGE)[0].subjects).toEqual(['e.example.com']);
  });

  it('ends even when the load fails', async () => {
    await expect(
      withEviction(['g.example.com'], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(evictedNames()).toEqual([]);
  });
});

describe('renewNowRatio', () => {
  const day = 86_400_000;
  const inWindow = (cert: { notBefore: number; notAfter: number }, ratio: number, at: number) =>
    at > cert.notAfter - (cert.notAfter - cert.notBefore) * ratio;

  it('covers a current certificate of any age and lifetime, and not its replacement', () => {
    const now = Date.UTC(2026, 8, 26);
    for (const [age, lifetime] of [
      [600, 90 * day],
      [60_000, 5 * 365 * day],
      [30 * day, 90 * day],
      [2 * 3_600_000, 6 * day],
    ]) {
      const current = { notBefore: now - age, notAfter: now - age + lifetime };
      const ratio = renewNowRatio(
        {
          notBefore: new Date(current.notBefore).toISOString(),
          notAfter: new Date(current.notAfter).toISOString(),
        },
        now,
      );
      expect(inWindow(current, ratio, now)).toBe(true);
      const next = { notBefore: now + 5_000, notAfter: now + 5_000 + lifetime };
      expect(inWindow(next, ratio, now + age * 0.8)).toBe(false);
    }
  });

  it('falls back to the fixed ratio without usable dates', () => {
    expect(renewNowRatio(null)).toBe(RENEW_NOW_WINDOW_RATIO);
    expect(renewNowRatio({ notBefore: 'soon', notAfter: 'later' })).toBe(RENEW_NOW_WINDOW_RATIO);
    // Already expired: every ratio covers it.
    expect(
      renewNowRatio({ notBefore: '2020-01-01T00:00:00Z', notAfter: '2020-04-01T00:00:00Z' }),
    ).toBe(RENEW_NOW_WINDOW_RATIO);
  });
});

describe('settling', () => {
  it('ends a request once a newer certificate covers the name', () => {
    const requestedAt = Date.now();
    requestRenewal('c.example.com', on(), requestedAt);
    expect(
      settleRenewals(EDGE, [
        { names: ['c.example.com'], notBefore: new Date(requestedAt - 86_400_000).toISOString() },
      ]),
    ).toBe(false);
    expect(
      settleRenewals(EDGE, [
        { names: ['c.example.com'], notBefore: new Date(requestedAt + 5_000).toISOString() },
      ]),
    ).toBe(true);
    expect(renewalsPending().has('c.example.com')).toBe(false);
  });

  it('gives up after the timeout, so a failing renewal stops asking', () => {
    const requestedAt = Date.now() - RENEWAL_TIMEOUT_MS - 1;
    requestRenewal('d.example.com', on(), requestedAt);
    expect(renewalsPending().has('d.example.com')).toBe(false);
  });
});

describe('several agents', () => {
  const policies = [{ subjects: ['shared.example.com'], issuers: [acme] }];
  const renewed = () => [{ names: ['shared.example.com'], notBefore: new Date().toISOString() }];

  it('keeps an agent renewing until its own report shows the new certificate', () => {
    requestRenewal('shared.example.com', [{ agent: 'one' }, { agent: 'two' }], Date.now() - 1000);
    expect(settleRenewals('one', renewed())).toBe(true);

    expect(withRenewalOverrides(policies, 'one')).toBe(policies);
    expect(withRenewalOverrides(policies, 'two')[0]).toHaveProperty('renewal_window_ratio');
    expect(renewalsPending().has('shared.example.com')).toBe(true);

    expect(settleRenewals('two', renewed())).toBe(true);
    expect(renewalsPending().has('shared.example.com')).toBe(false);
  });

  it("ignores a report about another agent's renewal", () => {
    requestRenewal('shared.example.com', [{ agent: 'two' }], Date.now() - 1000);
    // A (compromised) agent that was never asked can't end two's renewal by claiming a new cert.
    expect(settleRenewals('one', renewed())).toBe(false);
    expect(withRenewalOverrides(policies, 'two')[0]).toHaveProperty('renewal_window_ratio');
  });

  it("sizes each agent's window from its own certificate", () => {
    const now = Date.now();
    const day = 86_400_000;
    requestRenewal(
      'shared.example.com',
      [
        {
          agent: 'young',
          current: {
            notBefore: new Date(now - day).toISOString(),
            notAfter: new Date(now + 89 * day).toISOString(),
          },
        },
        { agent: 'unknown' },
      ],
      now,
    );
    const ratio = (agent: string) =>
      withRenewalOverrides(policies, agent, now)[0].renewal_window_ratio as number;
    expect(ratio('unknown')).toBe(RENEW_NOW_WINDOW_RATIO);
    expect(ratio('young')).not.toBe(RENEW_NOW_WINDOW_RATIO);
  });
});

describe('reachability probe', () => {
  it('answers a stable token on a path of its own, ahead of any host', () => {
    const route = reachabilityRoute() as {
      match: { path: string[] }[];
      handle: { body: string }[];
    };
    expect(route.match[0].path).toEqual([REACHABILITY_PATH]);
    expect(route.handle[0].body).toBe(reachabilityToken());
    expect(reachabilityToken()).toBe(reachabilityToken());
    // Unrelated to ACME's own path, so it can never answer a real challenge.
    expect(REACHABILITY_PATH.startsWith('/.well-known/acme-challenge')).toBe(false);
  });

  it('only checks real hostnames', () => {
    expect(isCheckableDomain('app.example.com')).toBe(true);
    for (const bad of ['localhost', '10.0.0.1', 'a..b', '*.example.com', 'http://x.com']) {
      expect(isCheckableDomain(bad)).toBe(false);
    }
  });
});
