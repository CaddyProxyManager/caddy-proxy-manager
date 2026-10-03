import { describe, expect, it } from 'bun:test';
import {
  type AccessListRuntime,
  buildAccessListHandlers,
  expandIpRules,
  hostnameRanges,
  ipDenyMatcherSets,
  MAX_ADDRESSES_PER_HOSTNAME,
  MAX_IP_RULES,
  normalizeCidr,
  normalizeRuleHostname,
  sanitizeIpRules,
} from '../../src/lib/access-list-rules';
import golden from './__golden__/access-list-handlers.json';

const account = { username: 'alice', passwordHash: '$2b$10$hash' };
const list = (over: Partial<AccessListRuntime>): AccessListRuntime => ({
  accounts: [],
  ipRules: [],
  ipDefault: 'deny',
  satisfy: 'all',
  passAuth: false,
  ...over,
});
const handlerNames = (handlers: Record<string, unknown>[]) => handlers.map((h) => h.handler);
type Route = { match?: { client_ip: { ranges: string[] } }[]; handle?: { handler: string }[] };
const routes = (handler: Record<string, unknown>) => handler.routes as Route[];

describe('normalizeCidr', () => {
  it('turns a bare address into a single-address range', () => {
    expect(normalizeCidr('10.0.0.5')).toBe('10.0.0.5/32');
    expect(normalizeCidr('2001:db8::1')).toBe('2001:db8::1/128');
  });

  it('keeps a valid range and refuses the rest', () => {
    expect(normalizeCidr(' 192.168.0.0/16 ')).toBe('192.168.0.0/16');
    expect(normalizeCidr('::/0')).toBe('::/0');
    for (const bad of ['10.0.0.0/', '10.0.0.0/33', '::/129', 'example.com', '10.0.0.0/-1', '']) {
      expect(normalizeCidr(bad)).toBeNull();
    }
  });
});

describe('sanitizeIpRules', () => {
  it('keeps order and names the first bad rule', () => {
    expect(
      sanitizeIpRules([
        { action: 'deny', cidr: '10.0.0.9' },
        { action: 'allow', cidr: '10.0.0.0/8', note: ' office ' },
      ]),
    ).toEqual([
      { action: 'deny', cidr: '10.0.0.9/32', hostname: null, note: null },
      { action: 'allow', cidr: '10.0.0.0/8', hostname: null, note: 'office' },
    ]);
    expect(() => sanitizeIpRules([{ action: 'allow', cidr: 'nope' }])).toThrow();
    expect(() => sanitizeIpRules([{ action: 'maybe', cidr: '10.0.0.1' }])).toThrow();
  });
});

describe('buildAccessListHandlers', () => {
  it('fails closed on an empty list', () => {
    const handlers = buildAccessListHandlers(list({}));
    expect(handlers).toEqual([
      { handler: 'static_response', status_code: 403, body: 'Access denied' },
    ]);
  });

  it('asks for a password, and strips it before the upstream unless told not to', () => {
    expect(handlerNames(buildAccessListHandlers(list({ accounts: [account] })))).toEqual([
      'authentication',
      'headers',
    ]);
    expect(
      handlerNames(buildAccessListHandlers(list({ accounts: [account], passAuth: true }))),
    ).toEqual(['authentication']);
  });

  it('checks IP rules in order, then the default', () => {
    const [subroute] = buildAccessListHandlers(
      list({
        ipRules: [
          { action: 'deny', ranges: ['10.0.0.9/32'] },
          { action: 'allow', ranges: ['10.0.0.0/8'] },
          { action: 'deny', ranges: ['10.1.0.0/16'] },
        ],
      }),
    );
    const [first, shadowed, fallback] = routes(subroute) as (Route & {
      match: { client_ip?: { ranges: string[] }; not?: { client_ip: { ranges: string[] } }[] }[];
    })[];
    expect(first.match[0].client_ip?.ranges).toEqual(['10.0.0.9/32']);
    // A later rule excludes everything above it, which is what makes the first match decide -
    // no route is terminal, since that would end the request instead of the subroute.
    expect(shadowed.match[0].not?.[0].client_ip.ranges).toEqual(['10.0.0.9/32', '10.0.0.0/8']);
    expect(fallback.match[0].not?.[0].client_ip.ranges).toEqual([
      '10.0.0.9/32',
      '10.0.0.0/8',
      '10.1.0.0/16',
    ]);
    expect(JSON.stringify(subroute)).not.toContain('terminal');
  });

  it('with a default of allow, lets unmatched addresses through', () => {
    const [subroute] = buildAccessListHandlers(
      list({
        ipRules: [{ action: 'deny', ranges: ['203.0.113.0/24'] }],
        ipDefault: 'allow',
      }),
    );
    expect(routes(subroute)).toHaveLength(1);
  });

  it('under all, needs both an allowed address and the password', () => {
    const handlers = buildAccessListHandlers(
      list({ accounts: [account], ipRules: [{ action: 'allow', ranges: ['10.0.0.0/8'] }] }),
    );
    expect(handlerNames(handlers)).toEqual(['subroute', 'authentication', 'headers']);
  });

  it('under any, lets an allowed address skip the password and asks everyone else', () => {
    const handlers = buildAccessListHandlers(
      list({
        accounts: [account],
        ipRules: [
          { action: 'allow', ranges: ['10.0.0.0/8'] },
          { action: 'deny', ranges: ['203.0.113.0/24'] },
        ],
        satisfy: 'any',
      }),
    );
    expect(handlerNames(handlers)).toEqual(['subroute', 'headers']);
    const [deny, fallback] = routes(handlers[0]);
    // Denied under "any" means "prove it with the password", not a flat refusal.
    expect(deny.handle?.[0].handler).toBe('authentication');
    expect(fallback.handle?.[0].handler).toBe('authentication');
  });
});

describe('ipDenyMatcherSets', () => {
  const rules = [
    { action: 'allow', ranges: ['10.0.0.0/8'] },
    { action: 'deny', ranges: ['10.9.0.0/16'] },
    { action: 'deny', ranges: ['2001:db8::/32'] },
    { action: 'allow', ranges: ['192.168.1.5/32'] },
  ] as const;

  it('leaves the HTTP handlers byte-identical to before it was extracted', () => {
    // Captured from ipSubroute before the refactor; a diff here changes every protected host.
    const cases: Record<keyof typeof golden, AccessListRuntime> = {
      denyDefault: list({ ipRules: [...rules] }),
      allowDefault: list({ ipRules: [...rules], ipDefault: 'allow' }),
      firstDeny: list({ ipRules: [rules[1], rules[0]] }),
      both: list({ ipRules: [...rules], accounts: [account] }),
      any: list({ ipRules: [...rules], accounts: [account], satisfy: 'any', passAuth: true }),
    };
    for (const [name, value] of Object.entries(cases)) {
      expect(JSON.stringify(buildAccessListHandlers(value))).toBe(
        JSON.stringify(golden[name as keyof typeof golden]),
      );
    }
  });

  it('builds the same decision table on remote_ip for layer 4', () => {
    expect(ipDenyMatcherSets(list({ ipRules: [...rules] }), 'remote_ip')).toEqual([
      { remote_ip: { ranges: ['10.9.0.0/16'] }, not: [{ remote_ip: { ranges: ['10.0.0.0/8'] } }] },
      {
        remote_ip: { ranges: ['2001:db8::/32'] },
        not: [{ remote_ip: { ranges: ['10.0.0.0/8', '10.9.0.0/16'] } }],
      },
      {
        not: [
          {
            remote_ip: {
              ranges: ['10.0.0.0/8', '10.9.0.0/16', '2001:db8::/32', '192.168.1.5/32'],
            },
          },
        ],
      },
    ]);
  });

  it('adds no default set when unmatched addresses are allowed', () => {
    const sets = ipDenyMatcherSets(list({ ipRules: [...rules], ipDefault: 'allow' }), 'remote_ip');
    expect(sets).toHaveLength(2);
  });
});

describe('hostname rules', () => {
  it('accepts a name, with an optional IPv6 prefix, and refuses what is not one', () => {
    expect(normalizeRuleHostname(' Home.Example.COM. ')).toBe('home.example.com');
    expect(normalizeRuleHostname('home.example.com/56')).toBe('home.example.com/56');
    expect(normalizeRuleHostname('nas')).toBe('nas');
    for (const bad of [
      '',
      '10.0.0.1',
      '10.0.0.300',
      'home.example.com/47',
      'home.example.com/129',
      'home.example.com/',
      'bad_label-.example.com',
      '-lead.example.com',
      'a..b',
      'has space.example.com',
      `${'a'.repeat(64)}.example.com`,
    ]) {
      expect(normalizeRuleHostname(bad), bad).toBeNull();
    }
  });

  it('takes exactly one of cidr and hostname', () => {
    expect(sanitizeIpRules([{ action: 'allow', hostname: 'Home.Example.com' }])).toEqual([
      { action: 'allow', cidr: null, hostname: 'home.example.com', note: null },
    ]);
    expect(() =>
      sanitizeIpRules([{ action: 'allow', cidr: '10.0.0.1', hostname: 'home.example.com' }]),
    ).toThrow();
    expect(() => sanitizeIpRules([{ action: 'allow' }])).toThrow();
    expect(() => sanitizeIpRules([{ action: 'allow', hostname: '10.0.0.1' }])).toThrow();
  });

  it('counts a hostname as one rule towards the cap', () => {
    const many = Array.from({ length: MAX_IP_RULES + 1 }, () => ({
      action: 'allow',
      hostname: 'home.example.com',
    }));
    expect(() => sanitizeIpRules(many)).toThrow();
    expect(sanitizeIpRules(many.slice(1))).toHaveLength(MAX_IP_RULES);
  });

  it('widens IPv6 to /64 unless told otherwise, and keeps IPv4 exact', () => {
    const answer = ['203.0.113.7', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::9'];
    expect(hostnameRanges(answer, 64)).toEqual(['203.0.113.7/32', '2001:db8:1:2::/64']);
    expect(hostnameRanges(answer, 128)).toEqual([
      '203.0.113.7/32',
      '2001:db8:1:2:aaaa:bbbb:cccc:dddd/128',
      '2001:db8:1:2::9/128',
    ]);
    expect(hostnameRanges(['2001:db8:1:2ff::1'], 56)).toEqual(['2001:db8:1:200::/56']);
  });

  it('drops unspecified and IPv4-mapped answers, and caps what one name adds', () => {
    expect(hostnameRanges(['0.0.0.0', '::', '::ffff:192.0.2.1', 'junk'], 64)).toEqual([]);
    const lots = Array.from({ length: 40 }, (_, i) => `192.0.2.${i}`);
    expect(hostnameRanges(lots, 64)).toHaveLength(MAX_ADDRESSES_PER_HOSTNAME);
  });

  it('expands in place, so the first matching rule still decides', () => {
    const lookup = (name: string) =>
      ({ 'home.example.com': ['198.51.100.4', '2001:db8::1'] })[name];
    expect(
      expandIpRules(
        [
          { action: 'deny', cidr: '198.51.100.0/24', hostname: null },
          { action: 'allow', cidr: null, hostname: 'home.example.com/128' },
          { action: 'deny', cidr: null, hostname: 'gone.example.com' },
          { action: 'allow', cidr: '10.0.0.0/8', hostname: null },
        ],
        lookup,
      ),
    ).toEqual([
      { action: 'deny', ranges: ['198.51.100.0/24'] },
      { action: 'allow', ranges: ['198.51.100.4/32', '2001:db8::1/128'] },
      { action: 'deny', ranges: [] },
      { action: 'allow', ranges: ['10.0.0.0/8'] },
    ]);
  });

  it('skips an unresolved rule: an allow admits nobody, a deny denies nobody', () => {
    const unresolvedAllow = list({ ipRules: [{ action: 'allow', ranges: [] }] });
    // Fail closed: with nothing above it, the default of deny covers every address.
    expect(ipDenyMatcherSets(unresolvedAllow, 'client_ip')).toEqual([
      { client_ip: { ranges: ['0.0.0.0/0', '::/0'] } },
    ]);
    const [subroute] = buildAccessListHandlers(unresolvedAllow);
    expect(routes(subroute)[0].handle?.[0].handler).toBe('static_response');

    // Fail open, which the UI warns about.
    const unresolvedDeny = list({ ipRules: [{ action: 'deny', ranges: [] }], ipDefault: 'allow' });
    expect(ipDenyMatcherSets(unresolvedDeny, 'remote_ip')).toEqual([]);

    const mixed = list({
      ipRules: [
        { action: 'deny', ranges: [] },
        { action: 'deny', ranges: ['192.0.2.0/24', '2001:db8::/64'] },
      ],
      ipDefault: 'allow',
    });
    expect(ipDenyMatcherSets(mixed, 'remote_ip')).toEqual([
      { remote_ip: { ranges: ['192.0.2.0/24', '2001:db8::/64'] } },
    ]);
  });
});
