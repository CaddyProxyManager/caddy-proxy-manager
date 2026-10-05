/** The access-log markers that tell analytics which gate answered a request. */
import { describe, expect, it } from 'bun:test';
import {
  instrumentOutcomes,
  isOutcomeMarker,
  tagOutcome,
} from '../../../src/lib/caddy/outcome-markers';
import { buildAccessListHandlers } from '../../../src/lib/access-lists/rules';

type Handler = Record<string, unknown>;
type Route = { handle: Handler[]; [key: string]: unknown };

const proxy = { handler: 'reverse_proxy', upstreams: [{ dial: 'app:80' }] };

/** A chain as labels: `=x` for a marker setting x, `log` for the log_append. */
function labels(handlers: Handler[]): string[] {
  return handlers.map((handler) => {
    if (handler.handler === 'log_append') return 'log';
    if (handler.handler === 'vars' && 'cpm_outcome' in handler) return `=${handler.cpm_outcome}`;
    return String(handler.handler);
  });
}

describe('instrumentOutcomes', () => {
  it('marks each gate before it and served after it, behind one log_append', () => {
    const route: Route = {
      match: [{ host: ['app.example.com'] }],
      handle: [
        { handler: 'encode' },
        { handler: 'crowdsec' },
        { handler: 'rate_limit' },
        { handler: 'blocker' },
        { handler: 'waf' },
        { handler: 'headers' },
        proxy,
      ],
    };
    instrumentOutcomes([route]);
    expect(labels(route.handle)).toEqual([
      'log',
      'encode',
      '=crowdsec',
      'crowdsec',
      '=rate_limit',
      'rate_limit',
      '=geo',
      'blocker',
      '=waf',
      'waf',
      '=served',
      'headers',
      'reverse_proxy',
    ]);
    expect(route.handle[0]).toEqual({
      handler: 'log_append',
      key: 'cpm_outcome',
      value: '{http.vars.cpm_outcome}',
    });
  });

  it('leaves a route with no gate exactly as it was', () => {
    const handle = [{ handler: 'headers' }, proxy];
    const route: Route = { handle: [...handle] };
    instrumentOutcomes([route]);
    expect(route.handle).toEqual(handle);
  });

  it('names a forward-auth subrequest by its tag', () => {
    const auth = tagOutcome(
      { handler: 'reverse_proxy', upstreams: [{ dial: 'auth:9091' }] },
      'auth',
    );
    const route: Route = { handle: [{ handler: 'waf' }, auth, proxy] };
    instrumentOutcomes([route]);
    expect(labels(route.handle)).toEqual([
      'log',
      '=waf',
      'waf',
      '=auth',
      'reverse_proxy',
      '=served',
      'reverse_proxy',
    ]);
  });

  it('marks gates inside subroutes, and logs once at the top', () => {
    const inner: Route = { handle: [{ handler: 'authentication' }] };
    const route: Route = { handle: [{ handler: 'subroute', routes: [inner] }, proxy] };
    instrumentOutcomes([route]);
    expect(labels(route.handle)).toEqual(['log', 'subroute', 'reverse_proxy']);
    expect(labels(inner.handle)).toEqual(['=auth', 'authentication', '=served']);
  });

  it('marks a subroute shared by several routes once', () => {
    const inner: Route = { handle: [{ handler: 'authentication' }] };
    const shared = { handler: 'subroute', routes: [inner] };
    const routes: Route[] = [{ handle: [shared, proxy] }, { handle: [shared, proxy] }];
    instrumentOutcomes(routes);
    instrumentOutcomes(routes);
    expect(labels(inner.handle)).toEqual(['=auth', 'authentication', '=served']);
    expect(routes.map((route) => labels(route.handle).filter((l) => l === 'log'))).toEqual([
      ['log'],
      ['log'],
    ]);
  });
});

describe('access lists', () => {
  const list = {
    accounts: [{ username: 'ann', passwordHash: '$2b$12$hash' }],
    ipRules: [{ action: 'allow' as const, ranges: ['10.0.0.0/8'] }],
    ipDefault: 'deny' as const,
    satisfy: 'all' as const,
    passAuth: false,
  };

  it('tells a refused address from a refused password', () => {
    const route: Route = { handle: [...buildAccessListHandlers(list), proxy] };
    instrumentOutcomes([route]);
    expect(labels(route.handle)).toEqual([
      'log',
      '=access',
      'subroute',
      '=auth',
      'authentication',
      '=served',
      'headers',
      'reverse_proxy',
    ]);
  });

  it('calls a password asked of an outside address auth, under satisfy any', () => {
    const route: Route = {
      handle: [...buildAccessListHandlers({ ...list, satisfy: 'any' }), proxy],
    };
    instrumentOutcomes([route]);
    const subroute = route.handle.find((handler) => handler.handler === 'subroute') as {
      routes: Route[];
    };
    expect(labels(subroute.routes[0]!.handle)).toEqual(['=auth', 'authentication', '=served']);
  });

  it('marks the deny of an empty list as access', () => {
    const route: Route = {
      handle: [...buildAccessListHandlers({ ...list, accounts: [], ipRules: [] }), proxy],
    };
    instrumentOutcomes([route]);
    expect(labels(route.handle)).toEqual([
      'log',
      '=access',
      'static_response',
      '=served',
      'reverse_proxy',
    ]);
  });
});

describe('isOutcomeMarker', () => {
  it('knows the markers and nothing else', () => {
    expect(isOutcomeMarker({ handler: 'vars', cpm_outcome: 'waf' })).toBe(true);
    expect(isOutcomeMarker({ handler: 'log_append', key: 'cpm_outcome', value: 'x' })).toBe(true);
    expect(isOutcomeMarker({ handler: 'vars', other: 1 })).toBe(false);
    expect(isOutcomeMarker({ handler: 'log_append', key: 'other', value: 'x' })).toBe(false);
  });
});
