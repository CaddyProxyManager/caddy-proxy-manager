import { describe, expect, it } from 'bun:test';
import {
  compareHostPatterns,
  groupHostPatternsByPriority,
  hostMatchesPattern,
  sortAutomationPoliciesBySubjectPriority,
  sortRoutesByHostPriority,
  sortTlsPoliciesBySniPriority,
} from '@/src/lib/proxy-hosts/pattern-priority';

describe('hostMatchesPattern', () => {
  it('matches an exact pattern only against the identical host', () => {
    expect(hostMatchesPattern('api.example.com', 'api.example.com')).toBe(true);
    expect(hostMatchesPattern('other.example.com', 'api.example.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hostMatchesPattern('API.example.com', 'api.EXAMPLE.com')).toBe(true);
  });

  it('matches a wildcard against exactly one extra label', () => {
    expect(hostMatchesPattern('radarr.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('sonarr.example.com', '*.example.com')).toBe(true);
  });

  it('does not match a wildcard against two extra labels', () => {
    expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(false);
  });

  it('does not match a wildcard against the bare apex domain', () => {
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false);
  });

  it('does not match a wildcard against an unrelated domain', () => {
    expect(hostMatchesPattern('evil.com', '*.example.com')).toBe(false);
  });
});

describe('compareHostPatterns', () => {
  it('puts exact hosts ahead of same-level wildcards', () => {
    expect(compareHostPatterns('api.example.com', '*.example.com')).toBeLessThan(0);
  });

  it('puts deeper patterns ahead of broader ones', () => {
    expect(compareHostPatterns('foo.sub.example.com', 'foo.example.com')).toBeLessThan(0);
    expect(compareHostPatterns('*.sub.example.com', '*.example.com')).toBeLessThan(0);
  });
});

describe('groupHostPatternsByPriority', () => {
  it('splits exact and wildcard domains into deterministic priority groups', () => {
    expect(
      groupHostPatternsByPriority([
        '*.example.com',
        'admin.example.com',
        '*.sub.example.com',
        'api.example.com',
      ]),
    ).toEqual([['admin.example.com', 'api.example.com'], ['*.sub.example.com'], ['*.example.com']]);
  });
});

describe('sortRoutesByHostPriority', () => {
  it('orders exact routes before matching wildcard routes', () => {
    const routes = sortRoutesByHostPriority([
      { match: [{ host: ['*.example.com'] }], id: 'wildcard' },
      { match: [{ host: ['api.example.com'] }], id: 'exact' },
    ]);

    expect(routes.map((route) => (route as { id: string }).id)).toEqual(['exact', 'wildcard']);
  });

  it('keeps path-specific routes ahead of catch-all routes for the same host group', () => {
    const routes = sortRoutesByHostPriority([
      { match: [{ host: ['api.example.com'] }], id: 'catch-all' },
      { match: [{ host: ['api.example.com'], path: ['/auth/*'] }], id: 'path' },
    ]);

    expect(routes.map((route) => (route as { id: string }).id)).toEqual(['path', 'catch-all']);
  });
});

describe('sortTlsPoliciesBySniPriority', () => {
  it('orders exact SNI policies before same-level wildcard SNI policies', () => {
    const policies = sortTlsPoliciesBySniPriority([
      { match: { sni: ['*.example.com'] }, id: 'wildcard' },
      { match: { sni: ['api.example.com'] }, id: 'exact' },
    ]);

    expect(policies.map((policy) => (policy as { id: string }).id)).toEqual(['exact', 'wildcard']);
  });
});

describe('sortAutomationPoliciesBySubjectPriority', () => {
  it('orders exact automation subjects before wildcard subjects', () => {
    const policies = sortAutomationPoliciesBySubjectPriority([
      { subjects: ['*.example.com'], id: 'wildcard' },
      { subjects: ['api.example.com'], id: 'exact' },
    ]);

    expect(policies.map((policy) => (policy as { id: string }).id)).toEqual(['exact', 'wildcard']);
  });
});
