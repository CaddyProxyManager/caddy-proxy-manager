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
  sanitizeDenyResponse,
  sanitizeIpRules,
  blockerDecisions,
  isRuleActive,
  l4DenyMatcherSets,
  listNeedsBlocker,
  type IpRule,
  type RuntimeIpRule,
} from '../../src/lib/access-lists/rules';
import { outcomeOf } from '../../src/lib/caddy/outcome-markers';
import golden from './__golden__/access-list-handlers.json';

const NO_GEO = { country: null, continent: null, asn: null, expiresAt: null };
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
      { action: 'deny', cidr: '10.0.0.9/32', hostname: null, note: null, ...NO_GEO },
      { action: 'allow', cidr: '10.0.0.0/8', hostname: null, note: 'office', ...NO_GEO },
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
      { action: 'allow', cidr: null, hostname: 'home.example.com', note: null, ...NO_GEO },
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

// ── Country, continent and ASN rules ─────────────────────────────────────────

/** A client as the blocker sees it; addresses are IPv4 so the test can check ranges itself. */
type Client = { ip: string | null; country: string; continent: string; asn: number };

function inRange(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  if (base!.includes(':')) return Number(bits) === 0 && !ip.includes('.');
  const toInt = (a: string) => a.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const size = 2 ** (32 - Number(bits));
  return Math.floor(toInt(ip) / size) === Math.floor(toInt(base!) / size);
}

type Fields = Record<string, unknown>;
function matches(handler: Fields, prefix: 'block' | 'allow', client: Client): boolean {
  if (!client.ip) return false;
  const values = <T>(key: string) => (handler[`${prefix}_${key}`] as T[] | undefined) ?? [];
  return (
    values<string>('cidrs').some((cidr) => inRange(client.ip!, cidr)) ||
    values<string>('countries').includes(client.country) ||
    values<string>('continents').includes(client.continent) ||
    values<number>('asns').includes(client.asn)
  );
}

/** The blocker module's own order: indeterminate and fail closed, allow, block, pass. */
function runBlockers(handlers: Fields[], client: Client): 'allow' | 'deny' {
  for (const handler of handlers) {
    if (handler.handler !== 'blocker') continue;
    if (!client.ip && handler.fail_closed) return 'deny';
    if (matches(handler, 'allow', client)) continue;
    if (matches(handler, 'block', client)) return 'deny';
  }
  return 'allow';
}

/** What the rules mean: the first match decides, then the default. */
function firstMatch(rules: RuntimeIpRule[], fallback: 'allow' | 'deny', client: Client) {
  for (const rule of rules) {
    const hit =
      (client.ip !== null && rule.ranges.some((cidr) => inRange(client.ip!, cidr))) ||
      (rule.countries ?? []).includes(client.country) ||
      (rule.continents ?? []).includes(client.continent) ||
      (rule.asns ?? []).includes(client.asn);
    if (hit) return rule.action;
  }
  return fallback;
}

const GEO_RULES: RuntimeIpRule[] = [
  { action: 'deny', ranges: ['192.0.2.7/32'] },
  { action: 'allow', ranges: [], countries: ['PT'] },
  { action: 'deny', ranges: [], continents: ['EU'] },
  { action: 'deny', ranges: [], asns: [64500] },
  { action: 'allow', ranges: ['192.0.2.0/24'] },
  { action: 'allow', ranges: [], asns: [64501] },
];

const CLIENTS: Client[] = [];
for (const ip of ['192.0.2.7', '192.0.2.8', '203.0.113.5']) {
  for (const country of ['PT', 'DE', 'US']) {
    for (const asn of [64500, 64501, 1]) {
      CLIENTS.push({ ip, country, continent: country === 'US' ? 'NA' : 'EU', asn });
    }
  }
}

describe('geo rules', () => {
  it('decide in order, exactly as the first matching rule would, under either default', () => {
    for (const ipDefault of ['deny', 'allow'] as const) {
      const handlers = buildAccessListHandlers(list({ ipRules: GEO_RULES, ipDefault }));
      for (const client of CLIENTS) {
        expect({ client, got: runBlockers(handlers, client) }).toEqual({
          client,
          got: firstMatch(GEO_RULES, ipDefault, client),
        });
      }
    }
  });

  it('share one blocker across a run of denies, and allow only what is above it', () => {
    const decisions = blockerDecisions(list({ ipRules: GEO_RULES }));
    expect(decisions).toHaveLength(3);
    expect(decisions[0]).toMatchObject({ block: { cidrs: ['192.0.2.7/32'] }, isDefault: false });
    expect(decisions[1]).toMatchObject({
      block: { continents: ['EU'], asns: [64500] },
      allow: { countries: ['PT'] },
    });
    expect(decisions[2]).toMatchObject({
      block: { cidrs: ['0.0.0.0/0', '::/0'] },
      allow: { countries: ['PT'], cidrs: ['192.0.2.0/24'], asns: [64501] },
      isDefault: true,
    });
  });

  it('are blocker handlers tagged as the access list, with the databases they need', () => {
    const handlers = buildAccessListHandlers(
      list({ ipRules: GEO_RULES, trustedProxies: ['10.0.0.0/8'] }),
    );
    expect(handlerNames(handlers)).toEqual(['blocker', 'blocker', 'blocker']);
    for (const handler of handlers) expect(outcomeOf(handler)).toBe('access');
    expect(handlers[0]).not.toHaveProperty('geoip_db');
    expect(handlers[1]).toMatchObject({
      geoip_db: '/usr/share/GeoIP/GeoLite2-Country.mmdb',
      asn_db: '/usr/share/GeoIP/GeoLite2-ASN.mmdb',
      trusted_proxies: ['10.0.0.0/8'],
      response_status: 403,
      response_body: 'Access denied',
    });
    // A client the blocker cannot place falls to the default.
    expect(handlers[2]?.fail_closed).toBe(true);
    expect(handlers[0]?.fail_closed).toBeUndefined();
    expect(runBlockers(handlers, { ip: null, country: 'PT', continent: 'EU', asn: 1 })).toBe(
      'deny',
    );
  });

  it('leave an address-only list on client_ip, as before', () => {
    const runtime = list({ ipRules: [{ action: 'allow', ranges: ['10.0.0.0/8'] }] });
    expect(listNeedsBlocker(runtime)).toBe(false);
    expect(handlerNames(buildAccessListHandlers(runtime))).toEqual(['subroute']);
  });

  it('under any, check credentials when sent and the rules otherwise', () => {
    const [subroute] = buildAccessListHandlers(
      list({ accounts: [account], ipRules: GEO_RULES, satisfy: 'any' }),
    );
    const [withCredentials, without] = (subroute as { routes: Fields[] }).routes;
    expect(withCredentials).toMatchObject({
      match: [{ header: { Authorization: ['*'] } }],
      handle: [{ handler: 'authentication' }],
    });
    expect(without!.match).toEqual([{ not: [{ header: { Authorization: ['*'] } }] }]);
    for (const blocker of without!.handle as Fields[]) {
      expect(blocker).toMatchObject({
        handler: 'blocker',
        response_status: 401,
        response_headers: { 'WWW-Authenticate': 'Basic realm="restricted"' },
      });
    }
    expect(JSON.stringify(subroute)).not.toContain('terminal');
  });

  it('are skipped without the blocker: an allow admits nobody, a deny denies nobody', () => {
    const rules = [
      { action: 'allow' as const, cidr: null, hostname: null, country: 'PT' },
      { action: 'deny' as const, cidr: null, hostname: null, asn: 64500 },
    ];
    expect(expandIpRules(rules, () => undefined, { geoUsable: false })).toEqual([
      { action: 'allow', ranges: [] },
      { action: 'deny', ranges: [] },
    ]);
    expect(expandIpRules(rules, () => undefined)).toEqual([
      { action: 'allow', ranges: [], countries: ['PT'] },
      { action: 'deny', ranges: [], asns: [64500] },
    ]);
  });

  it('become layer 4 blocker matchers, and address-only lists stay on remote_ip', () => {
    expect(l4DenyMatcherSets(list({ ipRules: GEO_RULES }))[1]).toEqual({
      blocker: {
        geoip_db: '/usr/share/GeoIP/GeoLite2-Country.mmdb',
        asn_db: '/usr/share/GeoIP/GeoLite2-ASN.mmdb',
        block_continents: ['EU'],
        block_asns: [64500],
        allow_countries: ['PT'],
      },
    });
    expect(
      l4DenyMatcherSets(list({ ipRules: [{ action: 'allow', ranges: ['10.0.0.0/8'] }] })),
    ).toEqual([{ not: [{ remote_ip: { ranges: ['10.0.0.0/8'] } }] }]);
  });
});

describe('sanitizeIpRules with geo targets', () => {
  const rule = (over: Partial<IpRule> & Pick<IpRule, 'action'>): IpRule => ({
    cidr: null,
    hostname: null,
    country: null,
    continent: null,
    asn: null,
    note: null,
    expiresAt: null,
    ...over,
  });

  it('normalises codes, takes AS-prefixed numbers, and keeps a note and an expiry', () => {
    expect(
      sanitizeIpRules([
        { action: 'deny', country: 'de' },
        { action: 'allow', continent: 'eu', note: ' team ' },
        { action: 'deny', asn: 'AS13335', expiresAt: '2030-01-01T00:00:00Z' },
      ]),
    ).toEqual([
      rule({ action: 'deny', country: 'DE' }),
      rule({ action: 'allow', continent: 'EU', note: 'team' }),
      rule({ action: 'deny', asn: 13335, expiresAt: '2030-01-01T00:00:00.000Z' }),
    ]);
  });

  it('refuses a bad code, two targets, or an unreadable expiry', () => {
    for (const bad of [
      { action: 'deny', country: 'XX' },
      { action: 'deny', country: 'Germany' },
      { action: 'deny', continent: 'EUR' },
      { action: 'deny', asn: '0' },
      { action: 'deny', asn: 'AS99999999999' },
      { action: 'deny', country: 'DE', cidr: '10.0.0.1' },
    ]) {
      expect(() => sanitizeIpRules([bad]), JSON.stringify(bad)).toThrow();
    }
    expect(() => sanitizeIpRules([{ action: 'deny', country: 'DE', expiresAt: 'soon' }])).toThrow(
      expect.objectContaining({ code: 'ipRuleExpiryInvalid' }),
    );
  });

  it('reads a rule as in force until its expiry', () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    expect(isRuleActive({ expiresAt: null }, now)).toBe(true);
    expect(isRuleActive({ expiresAt: '2030-01-01T00:00:01Z' }, now)).toBe(true);
    expect(isRuleActive({ expiresAt: '2030-01-01T00:00:00Z' }, now)).toBe(false);
  });
});

describe('deny response', () => {
  it('keeps the plain 403 for nothing, and refuses what Caddy should not be given', () => {
    expect(sanitizeDenyResponse(null)).toBeNull();
    expect(sanitizeDenyResponse({ status: 403, body: '  ' })).toBeNull();
    expect(sanitizeDenyResponse({ status: 451, body: 'Not here' })).toEqual({
      status: 451,
      body: 'Not here',
      redirectUrl: null,
    });
    expect(
      sanitizeDenyResponse({ redirectUrl: 'https://example.com/denied', status: 500 }),
    ).toEqual({ status: 302, body: null, redirectUrl: 'https://example.com/denied' });
    for (const bad of [
      { status: 302 },
      { status: 600 },
      { body: 'x'.repeat(8193) },
      { body: `bell${String.fromCharCode(7)}` },
      { redirectUrl: 'javascript:alert(1)' },
      { redirectUrl: 'https://example.com/{http.request.host}' },
      { redirectUrl: '/relative' },
    ]) {
      expect(() => sanitizeDenyResponse(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("answers with the list's response, braces kept literal by static_response", () => {
    const deny = { status: 451, body: 'Ask {ops}', redirectUrl: null };
    const [subroute] = buildAccessListHandlers(
      list({ ipRules: [{ action: 'allow', ranges: ['10.0.0.0/8'] }], deny }),
    );
    expect(routes(subroute!)[0]?.handle?.[0] as unknown).toEqual({
      handler: 'static_response',
      status_code: 451,
      body: String.raw`Ask \{ops\}`,
    });
    const [blocker] = buildAccessListHandlers(list({ ipRules: GEO_RULES, deny }));
    // The blocker writes its body verbatim, so it needs no escaping.
    expect(blocker).toMatchObject({ response_status: 451, response_body: 'Ask {ops}' });
  });

  it('redirects, from an empty list too', () => {
    const deny = { status: 302, body: null, redirectUrl: 'https://example.com/denied' };
    expect(buildAccessListHandlers(list({ deny }))).toEqual([
      {
        handler: 'static_response',
        status_code: 302,
        headers: { Location: ['https://example.com/denied'] },
      },
    ]);
    const [blocker] = buildAccessListHandlers(list({ ipRules: GEO_RULES, deny }));
    expect(blocker).toMatchObject({ redirect_url: 'https://example.com/denied' });
    expect(blocker).not.toHaveProperty('response_status');
  });
});

describe('fail closed', () => {
  it('puts a rule-less blocker first, given the module and trusted proxies', () => {
    const [first, second] = buildAccessListHandlers(
      list({
        ipRules: [{ action: 'allow', ranges: ['10.0.0.0/8'] }],
        failClosed: true,
        blockerUsable: true,
        trustedProxies: ['172.16.0.0/12'],
      }),
    );
    expect(first).toEqual({
      handler: 'blocker',
      trusted_proxies: ['172.16.0.0/12'],
      fail_closed: true,
      response_status: 403,
      response_body: 'Access denied',
    });
    expect(outcomeOf(first!)).toBe('access');
    expect(second?.handler).toBe('subroute');
  });

  it('adds nothing without the module or a trusted proxy, where every client is placed', () => {
    for (const over of [
      { blockerUsable: false, trustedProxies: ['172.16.0.0/12'] },
      { blockerUsable: true, trustedProxies: [] },
    ]) {
      const handlers = buildAccessListHandlers(
        list({ ipRules: [{ action: 'allow', ranges: ['10.0.0.0/8'] }], failClosed: true, ...over }),
      );
      expect(handlerNames(handlers)).toEqual(['subroute']);
    }
  });
});
