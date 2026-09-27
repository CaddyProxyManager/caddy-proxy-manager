import { describe, expect, it } from 'bun:test';
import { buildRedirectRoute, redirectPrefix } from '../../src/lib/caddy-redirects';

type Route = {
  match: { path: string[]; not?: { path_regexp: { pattern: string } }[] }[];
  handle: { handler: string; strip_path_prefix?: string; headers?: { Location: string[] } }[];
};

const route = (rule: Parameters<typeof buildRedirectRoute>[0]) => buildRedirectRoute(rule) as Route;
const location = (r: Route) => r.handle.at(-1)?.headers?.Location[0];

describe('buildRedirectRoute', () => {
  it('redirects to the target as is without preservePath', () => {
    const r = route({ from: '/.well-known/carddav', to: '/remote.php/dav/', status: 301 });
    expect(location(r)).toBe('/remote.php/dav/');
    expect(r.match[0].not).toBeUndefined();
  });

  it('appends the whole request URI in full mode', () => {
    const r = route({ from: '/*', to: 'https://new.example/', status: 308, preservePath: 'full' });
    expect(location(r)).toBe('https://new.example{http.request.uri}');
    expect(r.handle.some((h) => h.handler === 'rewrite')).toBe(false);
  });

  it('strips the prefix before appending in suffix mode', () => {
    const r = route({ from: '/old/*', to: '/new', status: 301, preservePath: 'suffix' });
    expect(r.handle[0]).toEqual({ handler: 'rewrite', strip_path_prefix: '/old' });
    expect(location(r)).toBe('/new{http.request.uri}');
  });

  it('never lets an appended path become protocol-relative', () => {
    // "/" as a target collapses to "", so the request path alone is the Location.
    const r = route({ from: '/*', to: '/', status: 301, preservePath: 'full' });
    const patterns = (r.match[0].not ?? []).map((n) => new RegExp(n.path_regexp.pattern));
    for (const path of ['//evil.example', '/\\evil.example']) {
      expect(patterns.some((p) => p.test(path))).toBe(true);
    }
    expect(patterns.some((p) => p.test('/ok/path'))).toBe(false);
  });

  it('excludes a doubled slash after the stripped prefix, in any case', () => {
    const r = route({ from: '/old/*', to: '/', status: 301, preservePath: 'suffix' });
    const patterns = (r.match[0].not ?? []).map(
      (n) => new RegExp(n.path_regexp.pattern.replace('(?i)', ''), 'i'),
    );
    expect(patterns.some((p) => p.test('/OLD//evil.example'))).toBe(true);
    expect(patterns.some((p) => p.test('/old/fine'))).toBe(false);
  });

  it('escapes regexp characters in the prefix', () => {
    const r = route({ from: '/a.b(c)/*', to: '/x', status: 301, preservePath: 'suffix' });
    const pattern = r.match[0].not?.[1]?.path_regexp.pattern ?? '';
    expect(pattern).toContain('/a\\.b\\(c\\)');
  });
});

describe('redirectPrefix', () => {
  it('stops at the first wildcard and drops trailing slashes', () => {
    expect(redirectPrefix('/old/*')).toBe('/old');
    expect(redirectPrefix('/old/*.php')).toBe('/old');
    expect(redirectPrefix('/exact')).toBe('/exact');
    expect(redirectPrefix('/*')).toBe('');
  });
});
