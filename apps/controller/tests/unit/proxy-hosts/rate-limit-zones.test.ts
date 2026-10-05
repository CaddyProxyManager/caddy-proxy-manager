/** Rate-limit keys, method filters, global zones with their modes, and the never-limited list. */
import { describe, expect, it } from 'bun:test';
import {
  buildRateLimitHandlers,
  effectiveRateLimitZones,
  type GlobalRateLimitSettings,
  type HostRateLimitMeta,
  normalizeHostRateLimitInput,
  sanitizeHostRateLimit,
} from '../../../src/lib/proxy-hosts/rate-limit';
import {
  normalizeGlobalRateLimitInput,
  sanitizeGlobalRateLimit,
} from '../../../src/lib/proxy-hosts/rate-limit-global';
import { forwardAuthIdentityHeader } from '../../../src/lib/caddy';
import { DomainError } from '../../../src/lib/errors/domain-error';

const zone = (over: Record<string, unknown> = {}) => ({
  max_events: 10,
  window: '1m',
  key: 'ip' as const,
  ...over,
});

function refusal(value: unknown): string | undefined {
  try {
    normalizeHostRateLimitInput(value);
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

type Limits = Record<string, Record<string, unknown>>;
const limitsOf = (handler: Record<string, unknown> | null) =>
  (handler?.rate_limits ?? {}) as Limits;

describe('zone input', () => {
  it('takes methods, a header key and a user key', () => {
    expect(
      normalizeHostRateLimitInput({
        enabled: true,
        mode: 'override',
        zones: [
          { maxEvents: 5, window: '1m', key: 'ip', methods: ['post', 'PUT', 'POST'] },
          { maxEvents: 100, window: '1m', key: 'header', header: 'X-Api-Key' },
          { maxEvents: 100, window: '1h', key: 'user' },
        ],
      }),
    ).toEqual({
      enabled: true,
      mode: 'override',
      zones: [
        { max_events: 5, window: '1m', key: 'ip', methods: ['POST', 'PUT'] },
        { max_events: 100, window: '1m', key: 'header', header: 'X-Api-Key' },
        { max_events: 100, window: '1h', key: 'user' },
      ],
    });
  });

  it('refuses a placeholder or space in a header, an unknown method or mode', () => {
    const one = (over: Record<string, unknown>) => ({
      enabled: true,
      zones: [{ maxEvents: 5, window: '1m', ...over }],
    });
    expect(refusal(one({ key: 'header', header: '{http.request.host}' }))).toBe(
      'hostRateLimitHeaderInvalid',
    );
    expect(refusal(one({ key: 'header', header: 'X Api' }))).toBe('hostRateLimitHeaderInvalid');
    expect(refusal(one({ key: 'header' }))).toBe('hostRateLimitHeaderInvalid');
    expect(refusal(one({ methods: ['BREW'] }))).toBe('hostRateLimitMethodInvalid');
    expect(refusal({ enabled: true, zones: [], mode: 'sometimes' })).toBe(
      'hostRateLimitModeInvalid',
    );
  });

  it('forgets inherit with nothing set, and remembers an override switched off', () => {
    expect(sanitizeHostRateLimit({ enabled: false, zones: [], mode: 'inherit' })).toBeUndefined();
    expect(sanitizeHostRateLimit({ enabled: false, zones: [], mode: 'override' })).toEqual({
      enabled: false,
      zones: [],
      mode: 'override',
    });
  });
});

describe('keys', () => {
  it('count a header by its value, and a request without it by its address', () => {
    const { pre } = buildRateLimitHandlers(1, {
      enabled: true,
      zones: [zone({ key: 'header', header: 'X-Api-Key', methods: ['POST'] })],
    });
    expect(limitsOf(pre)).toEqual({
      h1_0: {
        key: '{http.request.header.X-Api-Key}',
        window: '1m',
        max_events: 10,
        match: [{ method: ['POST'], header: { 'X-Api-Key': ['*'] } }],
      },
      h1_0_ip: {
        key: '{http.vars.client_ip}',
        window: '1m',
        max_events: 10,
        match: [{ method: ['POST'], not: [{ header: { 'X-Api-Key': ['*'] } }] }],
      },
    });
    // A header's value can be a credential, which a per-key metric label would publish.
    expect(pre?.disable_metrics).toBe(true);
    expect(JSON.stringify(pre)).not.toContain('log_key');
  });

  it('count the signed-in user after sign-in, or the address without forward auth', () => {
    const meta: HostRateLimitMeta = {
      enabled: true,
      zones: [zone({ key: 'ip' }), zone({ key: 'user', window: '1h' })],
    };
    const signedIn = buildRateLimitHandlers(2, meta, { identityHeader: 'X-Cpm-User-Id' });
    expect(Object.keys(limitsOf(signedIn.pre))).toEqual(['h2_0']);
    expect(signedIn.pre?.disable_metrics).toBeUndefined();
    expect(limitsOf(signedIn.postAuth)).toEqual({
      h2_1: {
        key: '{http.request.header.X-Cpm-User-Id}',
        window: '1h',
        max_events: 10,
        match: [{ header: { 'X-Cpm-User-Id': ['*'] } }],
      },
      h2_1_ip: {
        key: '{http.vars.client_ip}',
        window: '1h',
        max_events: 10,
        match: [{ not: [{ header: { 'X-Cpm-User-Id': ['*'] } }] }],
      },
    });
    expect(signedIn.postAuth?.disable_metrics).toBe(true);

    const anonymous = buildRateLimitHandlers(2, meta);
    expect(anonymous.postAuth).toBeNull();
    expect(limitsOf(anonymous.pre).h2_1).toEqual({
      key: '{http.vars.client_ip}',
      window: '1h',
      max_events: 10,
    });
  });

  it('read the identity from the header the host forward auth copies', () => {
    const none = { authentik: null, forwardAuth: null, cpmForwardAuth: null };
    expect(forwardAuthIdentityHeader(none)).toBeNull();
    expect(forwardAuthIdentityHeader({ ...none, cpmForwardAuth: { enabled: true } })).toBe(
      'X-Cpm-User-Id',
    );
    expect(
      forwardAuthIdentityHeader({ ...none, forwardAuth: { copyHeaders: ['remote-user'] } }),
    ).toBe('Remote-User');
    expect(
      forwardAuthIdentityHeader({ ...none, forwardAuth: { copyHeaders: ['Remote-Email'] } }),
    ).toBeNull();
    expect(
      forwardAuthIdentityHeader({
        ...none,
        authentik: { copyHeaders: ['X-Authentik-Username', 'X-Authentik-Uid'] },
      }),
    ).toBe('X-Authentik-Uid');
  });
});

describe('global zones', () => {
  const global: GlobalRateLimitSettings = {
    enabled: true,
    zones: [zone({ max_events: 1000 })],
    allowlist: ['10.0.0.0/8'],
  };
  const own: HostRateLimitMeta = { enabled: true, zones: [zone({ paths: ['/login'] })] };
  const names = (meta: HostRateLimitMeta | undefined, g = global) =>
    effectiveRateLimitZones(7, meta, g).map((entry) => entry.name);

  it('combine with a host by its mode, each counted per host', () => {
    expect(names(undefined)).toEqual(['h7_g0']);
    expect(names({ ...own, mode: 'inherit' })).toEqual(['h7_g0']);
    expect(names({ ...own, mode: 'merge' })).toEqual(['h7_g0', 'h7_0']);
    expect(names({ ...own, mode: 'override' })).toEqual(['h7_0']);
    expect(names({ ...own, enabled: false, mode: 'override' })).toEqual([]);
    // A host stored before global zones keeps its own, and takes the global ones beside them.
    expect(names(own)).toEqual(['h7_g0', 'h7_0']);
    expect(names(undefined, { ...global, enabled: false })).toEqual([]);
  });

  it('never count the allowlisted addresses, on the host zones too', () => {
    const { pre } = buildRateLimitHandlers(7, { ...own, mode: 'merge' }, { global });
    const limits = limitsOf(pre);
    expect(limits.h7_g0?.match).toEqual([{ not: [{ client_ip: { ranges: ['10.0.0.0/8'] } }] }]);
    expect(limits.h7_0?.match).toEqual([
      { path: ['/login'], not: [{ client_ip: { ranges: ['10.0.0.0/8'] } }] },
    ]);
  });

  it('build nothing when no zone applies', () => {
    expect(buildRateLimitHandlers(7, undefined, { global: null })).toEqual({
      pre: null,
      postAuth: null,
    });
  });
});

describe('the global setting', () => {
  it('normalises the allowlist and refuses what is no address', () => {
    expect(
      normalizeGlobalRateLimitInput({
        enabled: true,
        zones: [{ maxEvents: 60, window: '1m', key: 'ip+path' }],
        allowlist: ['10.0.0.1', '192.168.0.0/16', '10.0.0.1'],
      }),
    ).toEqual({
      enabled: true,
      zones: [{ max_events: 60, window: '1m', key: 'ip+path' }],
      allowlist: ['10.0.0.1/32', '192.168.0.0/16'],
    });
    expect(() => normalizeGlobalRateLimitInput({ enabled: true, allowlist: ['nope'] })).toThrow(
      expect.objectContaining({ code: 'rateLimitAllowlistEntryInvalid' }),
    );
    expect(() =>
      normalizeGlobalRateLimitInput({
        enabled: true,
        zones: Array.from({ length: 21 }, () => ({ maxEvents: 1, window: '1m' })),
      }),
    ).toThrow(expect.objectContaining({ code: 'hostRateLimitTooManyZones' }));
  });

  it('reads a stored blob leniently, dropping what Caddy would refuse', () => {
    expect(sanitizeGlobalRateLimit(null)).toBeNull();
    expect(
      sanitizeGlobalRateLimit({
        enabled: true,
        zones: [{ max_events: 0, window: '1m' }],
        allowlist: ['bad', '::1'],
      }),
    ).toEqual({ enabled: true, zones: [], allowlist: ['::1/128'] });
  });
});
