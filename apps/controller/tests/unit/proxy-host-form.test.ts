/**
 * The host form's FormData parsing. The contract every section shares: no marker means the section
 * was not rendered and is left alone (`undefined`); a rendered but emptied field is a real edit
 * that clears. Malformed values are dropped or refused, never passed through half-read.
 */
import { describe, expect, it } from 'bun:test';
import { DomainError } from '@/src/lib/domain-error';
import {
  parseAnubisConfig,
  parseAuthentikConfig,
  parseCacheConfig,
  parseCompressionMode,
  parseCpmForwardAuthConfig,
  parseCrowdSecEnabled,
  parseDnsResolverConfig,
  parseErrorPagesConfig,
  parseForwardAuthConfig,
  parseGeoBlockConfig,
  parseLoadBalancerConfig,
  parseLocationRulesConfig,
  parseMaintenanceConfig,
  parseMtlsConfig,
  parsePathAllowsConfig,
  parsePathBlocksConfig,
  parsePathRewritesConfig,
  parseProxyHostOptionUpdates,
  parseRateLimitConfig,
  parseRedirectUrl,
  parseRedirectsConfig,
  parseResponseHeaders,
  parseRewriteConfig,
  parseTailscaleConfig,
  parseUpstreamDnsResolutionConfig,
  parseUpstreamTimeoutsConfig,
  parseWafConfig,
  parseWeightList,
} from '@/src/lib/proxy-host-form';

type Entries = Record<string, string | string[]>;

function form(entries: Entries = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

const MIB = 1024 * 1024;

describe('parseAuthentikConfig', () => {
  it('is undefined when the section was not rendered', () => {
    expect(parseAuthentikConfig(form({ authentikEnabled: 'on' }))).toBeUndefined();
  });

  it('reads every field of a rendered section', () => {
    expect(
      parseAuthentikConfig(
        form({
          authentikPresent: '1',
          authentikEnabledPresent: '1',
          authentikEnabled: 'on',
          authentikOutpostDomain: ' outpost.example.com ',
          authentikOutpostUpstream: 'authentik:9000',
          authentikAuthEndpoint: '/outpost.goauthentik.io/auth/caddy',
          authentikCopyHeaders: 'X-Authentik-Username, X-Authentik-Email\nX-Authentik-Uid',
          authentikTrustedProxies: 'private_ranges',
          authentikProtectedPaths: '/admin/*',
          authentikExcludedPaths: '/health',
          authentikSetHostHeaderPresent: '1',
          authentikSetHostHeader: 'on',
        }),
      ),
    ).toEqual({
      enabled: true,
      outpostDomain: 'outpost.example.com',
      outpostUpstream: 'authentik:9000',
      authEndpoint: '/outpost.goauthentik.io/auth/caddy',
      copyHeaders: ['X-Authentik-Username', 'X-Authentik-Email', 'X-Authentik-Uid'],
      trustedProxies: ['private_ranges'],
      protectedPaths: ['/admin/*'],
      excludedPaths: ['/health'],
      setOutpostHostHeader: true,
    });
  });

  it('reads an unchecked switch as off and an emptied list as a clear', () => {
    expect(
      parseAuthentikConfig(
        form({
          authentikPresent: '1',
          authentikEnabledPresent: '1',
          authentikCopyHeaders: '',
          authentikSetHostHeaderPresent: '1',
        }),
      ),
    ).toEqual({ enabled: false, copyHeaders: [], setOutpostHostHeader: false });
  });

  it('is undefined for a rendered section carrying nothing', () => {
    expect(parseAuthentikConfig(form({ authentikPresent: '1' }))).toBeUndefined();
  });
});

describe('parseForwardAuthConfig', () => {
  it('is undefined without its marker', () => {
    expect(parseForwardAuthConfig(form({ forwardAuthEnabled: 'on' }))).toBeUndefined();
  });

  it('reads a rendered section, passing the provider through for the model to check', () => {
    expect(
      parseForwardAuthConfig(
        form({
          forwardAuthPresent: '1',
          forwardAuthEnabledPresent: '1',
          forwardAuthEnabled: 'true',
          forwardAuthProvider: 'no-such-provider',
          forwardAuthUpstream: 'authelia:9091',
          forwardAuthEndpoint: '/api/authz/forward-auth',
          forwardAuthCopyHeaders: 'Remote-User,Remote-Groups',
          forwardAuthTrustedProxies: '10.0.0.0/8',
          forwardAuthApiSplitPresent: '1',
          forwardAuthApiSplit: 'on',
          forwardAuthApiBypassHeaders: 'Authorization',
          forwardAuthProtectedPaths: '/app/*',
          forwardAuthExcludedPaths: '/public/*',
        }),
      ),
    ).toEqual({
      enabled: true,
      provider: 'no-such-provider' as never,
      authUpstream: 'authelia:9091',
      authEndpoint: '/api/authz/forward-auth',
      copyHeaders: ['Remote-User', 'Remote-Groups'],
      trustedProxies: ['10.0.0.0/8'],
      apiSplit: true,
      apiBypassHeaders: ['Authorization'],
      protectedPaths: ['/app/*'],
      excludedPaths: ['/public/*'],
    });
  });

  it('leaves unrendered advanced fields out, so a save does not clear them', () => {
    const parsed = parseForwardAuthConfig(
      form({ forwardAuthPresent: '1', forwardAuthEnabledPresent: '1' }),
    );
    expect(parsed).toEqual({ enabled: false });
  });
});

describe('parseCpmForwardAuthConfig', () => {
  it('reads the switch from its value, and emptied path lists as null', () => {
    expect(
      parseCpmForwardAuthConfig(
        form({
          cpmForwardAuthPresent: '1',
          cpmForwardAuthEnabledPresent: '1',
          cpmForwardAuthEnabled: 'false',
          cpmForwardAuthProtectedPaths: '',
          cpmForwardAuthExcludedPaths: '/login, /static/*',
        }),
      ),
    ).toEqual({ enabled: false, protected_paths: null, excluded_paths: ['/login', '/static/*'] });
  });

  it('is undefined without its marker or with nothing in it', () => {
    expect(parseCpmForwardAuthConfig(form({ cpmForwardAuthEnabled: 'on' }))).toBeUndefined();
    expect(parseCpmForwardAuthConfig(form({ cpmForwardAuthPresent: '1' }))).toBeUndefined();
  });
});

describe('parseTailscaleConfig', () => {
  it('reads only the fields that were rendered', () => {
    expect(parseTailscaleConfig(form({ tailscalePresent: '1', tailscaleServe: 'on' }))).toEqual({
      serve: true,
    });
  });

  it('reads every field, blank node names and paths clearing', () => {
    expect(
      parseTailscaleConfig(
        form({
          tailscalePresent: '1',
          tailscaleServe: 'false',
          tailscaleNode: '  ',
          tailscaleTailnetOnly: 'on',
          tailscaleAuth: 'on',
          tailscaleProtectedPaths: '',
          tailscaleExcludedPaths: '/health',
          tailscaleForwardIdentity: 'on',
          tailscaleUpstreamNode: 'nas',
        }),
      ),
    ).toEqual({
      serve: false,
      node: '',
      tailnetOnly: true,
      auth: true,
      protected_paths: null,
      excluded_paths: ['/health'],
      forwardIdentity: true,
      upstreamNode: 'nas',
    });
  });

  it('is undefined without its marker or with nothing rendered', () => {
    expect(parseTailscaleConfig(form({ tailscaleServe: 'on' }))).toBeUndefined();
    expect(parseTailscaleConfig(form({ tailscalePresent: '1' }))).toBeUndefined();
  });
});

describe('parseRedirectUrl', () => {
  it.each([
    ['https://example.com/blocked', 'https://example.com/blocked'],
    ['  http://example.com  ', 'http://example.com'],
    ['javascript:alert(1)', ''],
    ['ftp://example.com', ''],
    ['/relative', ''],
    ['', ''],
  ])('reads %p as %p', (raw, expected) => {
    expect(parseRedirectUrl(raw)).toBe(expected);
  });

  it('reads a missing value as empty', () => {
    expect(parseRedirectUrl(null)).toBe('');
  });
});

describe('parseWeightList', () => {
  it('reads weights in upstream order', () => {
    expect(parseWeightList(' 1, 5 ,, 0,1000 ')).toEqual([1, 5, 0, 1000]);
  });

  it.each(['3,x', '1,1001', '1,-2', ''])(
    'refuses %p whole, rather than zeroing one backend',
    (raw) => {
      expect(parseWeightList(raw)).toBeNull();
    },
  );

  it('reads a missing or separator-only value as none', () => {
    expect(parseWeightList(null)).toBeNull();
    expect(parseWeightList(' , ')).toBeNull();
  });
});

describe('parseLoadBalancerConfig', () => {
  it('is undefined without its marker', () => {
    expect(parseLoadBalancerConfig(form({ lbEnabled: 'on' }))).toBeUndefined();
  });

  it('reads a full section', () => {
    expect(
      parseLoadBalancerConfig(
        form({
          lbPresent: '1',
          lbEnabledPresent: '1',
          lbEnabled: 'on',
          lbPolicy: 'cookie',
          lbPolicyHeaderField: 'X-User',
          lbPolicyCookieName: 'lb',
          lbPolicyCookieSecret: 's3cret',
          lbPolicyQueryKey: 'k',
          lbPolicyChoose: '2',
          lbPolicyWeights: '3,1',
          lbTryDuration: '5s',
          lbTryInterval: '250ms',
          lbRetries: '3',
          lbActiveHealthEnabledPresent: '1',
          lbActiveHealthEnabled: 'on',
          lbActiveHealthUri: '/health',
          lbActiveHealthPort: '8081',
          lbActiveHealthInterval: '30s',
          lbActiveHealthTimeout: '5s',
          lbActiveHealthStatus: '200',
          lbActiveHealthBody: 'ok',
          lbActiveHealthPasses: '2',
          lbActiveHealthFails: '3',
          lbActiveHealthMethod: 'HEAD',
          lbActiveHealthRequestBody: '',
          lbActiveHealthFollowRedirectsPresent: '1',
          lbActiveHealthFollowRedirects: 'on',
          lbPassiveHealthEnabledPresent: '1',
          lbPassiveHealthEnabled: 'on',
          lbPassiveHealthFailDuration: '30s',
          lbPassiveHealthMaxFails: '5',
          lbPassiveHealthUnhealthyStatus: '500, 502,abc,42',
          lbPassiveHealthUnhealthyLatency: '2s',
          lbPassiveHealthUnhealthyRequestCount: '100',
        }),
      ),
    ).toEqual({
      enabled: true,
      policy: 'cookie',
      policyHeaderField: 'X-User',
      policyCookieName: 'lb',
      policyCookieSecret: 's3cret',
      policyQueryKey: 'k',
      policyChoose: 2,
      policyWeights: [3, 1],
      tryDuration: '5s',
      tryInterval: '250ms',
      retries: 3,
      activeHealthCheck: {
        enabled: true,
        uri: '/health',
        port: 8081,
        interval: '30s',
        timeout: '5s',
        status: 200,
        body: 'ok',
        passes: 2,
        fails: 3,
        method: 'HEAD',
        requestBody: null,
        followRedirects: true,
      },
      passiveHealthCheck: {
        enabled: true,
        failDuration: '30s',
        maxFails: 5,
        unhealthyStatus: [500, 502],
        unhealthyLatency: '2s',
        unhealthyRequestCount: 100,
      },
    });
  });

  it('drops an unknown policy and reads unchecked health switches as off', () => {
    const parsed = parseLoadBalancerConfig(
      form({
        lbPresent: '1',
        lbEnabledPresent: '1',
        lbPolicy: 'fastest',
        lbActiveHealthEnabledPresent: '1',
        lbPassiveHealthEnabledPresent: '1',
        lbPassiveHealthUnhealthyStatus: 'x,42',
      }),
    );
    expect(parsed?.enabled).toBe(false);
    expect(parsed).not.toHaveProperty('policy');
    expect(parsed?.activeHealthCheck?.enabled).toBe(false);
    expect(parsed?.activeHealthCheck?.followRedirects).toBeUndefined();
    expect(parsed?.passiveHealthCheck?.enabled).toBe(false);
    expect(parsed?.passiveHealthCheck?.unhealthyStatus).toBeNull();
  });

  it('clears an emptied field and leaves an unrendered one alone', () => {
    const parsed = parseLoadBalancerConfig(
      form({ lbPresent: '1', lbPolicyCookieName: '', lbPolicyWeights: '1,x' }),
    );
    expect(parsed).toEqual({ policyCookieName: null, policyWeights: null });
    expect(parsed).not.toHaveProperty('policyHeaderField');
    expect(parsed).not.toHaveProperty('activeHealthCheck');
  });

  it('is undefined for a rendered section carrying nothing', () => {
    expect(parseLoadBalancerConfig(form({ lbPresent: '1' }))).toBeUndefined();
  });
});

describe('parseGeoBlockConfig', () => {
  it('reads no section as no rules, merged', () => {
    expect(parseGeoBlockConfig(form())).toEqual({ geoblock: null, geoblockMode: 'merge' });
  });

  it('reads every list, dropping unparseable ASNs', () => {
    const { geoblock, geoblockMode } = parseGeoBlockConfig(
      form({
        geoblockPresent: '1',
        geoblockEnabled: 'on',
        geoblockMode: 'override',
        geoblockBlockCountries: 'RU, CN',
        geoblockBlockContinents: 'AN',
        geoblockBlockAsns: '13335, bogus, 15169',
        geoblockBlockCidrs: '203.0.113.0/24',
        geoblockBlockIps: '198.51.100.7',
        geoblockAllowCountries: 'NZ',
        geoblockAllowContinents: 'OC',
        geoblockAllowAsns: '64512',
        geoblockAllowCidrs: '10.0.0.0/8',
        geoblockAllowIps: '192.0.2.1',
        geoblockTrustedProxies: '172.16.0.0/12',
        geoblockFailClosed: 'on',
        geoblockResponseStatus: '451',
        geoblockResponseBody: 'Unavailable here',
        'geoblockResponseHeadersKeys[]': ['X-Reason', 'bad header', ''],
        'geoblockResponseHeadersValues[]': [' geo ', 'x', 'y'],
        geoblockRedirectUrl: 'https://example.com/why',
      }),
    );
    expect(geoblockMode).toBe('override');
    expect(geoblock).toEqual({
      enabled: true,
      block_countries: ['RU', 'CN'],
      block_continents: ['AN'],
      block_asns: [13335, 15169],
      block_cidrs: ['203.0.113.0/24'],
      block_ips: ['198.51.100.7'],
      allow_countries: ['NZ'],
      allow_continents: ['OC'],
      allow_asns: [64512],
      allow_cidrs: ['10.0.0.0/8'],
      allow_ips: ['192.0.2.1'],
      trusted_proxies: ['172.16.0.0/12'],
      fail_closed: true,
      response_status: 451,
      response_body: 'Unavailable here',
      response_headers: { 'X-Reason': 'geo' },
      redirect_url: 'https://example.com/why',
    });
  });

  it('falls back to a 403 "Forbidden" and merge for missing or out-of-range values', () => {
    const { geoblock, geoblockMode } = parseGeoBlockConfig(
      form({
        geoblockPresent: '1',
        geoblockMode: 'replace',
        geoblockResponseStatus: '700',
        geoblockFailClosed: 'true',
        geoblockRedirectUrl: 'javascript:alert(1)',
      }),
    );
    expect(geoblockMode).toBe('merge');
    expect(geoblock).toMatchObject({
      enabled: false,
      block_countries: [],
      fail_closed: false,
      response_status: 403,
      response_body: 'Forbidden',
      response_headers: {},
      redirect_url: '',
    });
  });

  it('reads a header with no value as empty', () => {
    expect(parseResponseHeaders(form({ 'geoblockResponseHeadersKeys[]': 'X-Geo' }))).toEqual({
      'X-Geo': '',
    });
  });
});

describe('parseWafConfig', () => {
  it('is empty without its marker, so the host keeps its WAF', () => {
    expect(parseWafConfig(form({ wafEnabled: 'on' }))).toEqual({});
  });

  it('keeps only the mode when switched off', () => {
    expect(
      parseWafConfig(
        form({ wafPresent: '1', wafMode: 'override', wafCustomDirectives: 'SecRuleEngine On' }),
      ),
    ).toEqual({ waf: { enabled: false, waf_mode: 'override' } });
  });

  it('reads an enabled section, converting body limits from MiB', () => {
    expect(
      parseWafConfig(
        form({
          wafPresent: '1',
          wafEnabled: 'on',
          wafEngineMode: 'On',
          wafLoadOwaspCrs: 'on',
          wafCustomDirectives: '  SecRule ARGS "@contains x" "id:1,deny"  ',
          wafExcludedRuleIds: '[942100, 0, -1, "920350", 1.5, 920350]',
          wafPresetIds: '[2, 2, 3]',
          wafPluginIds: '[7]',
          wafRequestBodyLimitMb: '16',
          wafRequestBodyInMemoryLimitMb: '1',
          wafRequestBodyLimitAction: 'ProcessPartial',
        }),
      ),
    ).toEqual({
      waf: {
        enabled: true,
        mode: 'On',
        load_owasp_crs: true,
        custom_directives: 'SecRule ARGS "@contains x" "id:1,deny"',
        excluded_rule_ids: [942100, 920350],
        preset_ids: [2, 3],
        plugin_ids: [7],
        waf_mode: 'merge',
        request_body_limit: 16 * MIB,
        request_body_in_memory_limit: 1 * MIB,
        request_body_limit_action: 'ProcessPartial',
      },
    });
  });

  it('leaves blank limits, unknown modes and empty id lists to inherit', () => {
    expect(
      parseWafConfig(
        form({
          wafPresent: '1',
          wafEnabled: 'on',
          wafEngineMode: 'DetectionOnly',
          wafPresetIds: '[]',
          wafRequestBodyLimitMb: ' ',
          wafRequestBodyLimitAction: 'Drop',
        }),
      ),
    ).toEqual({
      waf: {
        enabled: true,
        mode: undefined,
        load_owasp_crs: false,
        custom_directives: '',
        excluded_rule_ids: [],
        waf_mode: 'merge',
      },
    });
  });

  it.each([
    ['wafRequestBodyLimitMb', '0', 'hostWafRequestBodyLimitInvalid'],
    ['wafRequestBodyLimitMb', '2.5', 'hostWafRequestBodyLimitInvalid'],
    ['wafRequestBodyInMemoryLimitMb', 'lots', 'hostWafInMemoryBodyLimitInvalid'],
  ] as const)('refuses %s = %p with %s', (field, value, code) => {
    let caught: unknown;
    try {
      parseWafConfig(form({ wafPresent: '1', wafEnabled: 'on', [field]: value }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(code);
  });

  it.each([
    ['wafExcludedRuleIds', '[1,'],
    ['wafPresetIds', 'nope'],
    ['wafPluginIds', '{"id":1}'],
  ])(
    'refuses a malformed %s outright, with a catalog code rather than the engine message',
    (field, value) => {
      let caught: unknown;
      try {
        parseWafConfig(form({ wafPresent: '1', wafEnabled: 'on', [field]: value }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe('wafIdListInvalid');
    },
  );
});

describe('parseDnsResolverConfig', () => {
  it('is undefined without its marker or with nothing in it', () => {
    expect(parseDnsResolverConfig(form({ dnsResolvers: '1.1.1.1' }))).toBeUndefined();
    expect(parseDnsResolverConfig(form({ dnsPresent: '1' }))).toBeUndefined();
  });

  it('splits resolvers and fallbacks on commas and newlines', () => {
    expect(
      parseDnsResolverConfig(
        form({
          dnsPresent: '1',
          dnsEnabledPresent: '1',
          dnsEnabled: 'on',
          dnsResolvers: '1.1.1.1, 8.8.8.8\n9.9.9.9',
          dnsFallbacks: '\n208.67.222.222\n',
          dnsTimeout: '5s',
        }),
      ),
    ).toEqual({
      enabled: true,
      resolvers: ['1.1.1.1', '8.8.8.8', '9.9.9.9'],
      fallbacks: ['208.67.222.222'],
      timeout: '5s',
    });
  });

  it('reads an emptied resolver list as a clear and an unchecked switch as off', () => {
    expect(
      parseDnsResolverConfig(
        form({ dnsPresent: '1', dnsEnabledPresent: '1', dnsResolvers: '', dnsFallbacks: ' , ' }),
      ),
    ).toEqual({ enabled: false, resolvers: [] });
  });
});

describe('parseUpstreamDnsResolutionConfig', () => {
  it('is undefined without its marker', () => {
    expect(
      parseUpstreamDnsResolutionConfig(form({ upstreamDnsResolutionMode: 'enabled' })),
    ).toBeUndefined();
  });

  it.each([
    [
      { upstreamDnsResolutionMode: 'enabled', upstreamDnsResolutionFamily: 'ipv4' },
      { enabled: true, family: 'ipv4' },
    ],
    [
      { upstreamDnsResolutionMode: 'disabled', upstreamDnsResolutionFamily: 'both' },
      { enabled: false, family: 'both' },
    ],
    [{}, { enabled: null, family: null }],
    [{ upstreamDnsResolutionMode: 'sometimes', upstreamDnsResolutionFamily: 'ipx' }, undefined],
  ] as const)('reads %p as %p', (fields, expected) => {
    expect(
      parseUpstreamDnsResolutionConfig(form({ upstreamDnsResolutionPresent: '1', ...fields })),
    ).toEqual(expected as never);
  });
});

describe('parseMtlsConfig', () => {
  it('is null without its marker or while off', () => {
    expect(parseMtlsConfig(form({ mtlsEnabled: 'true' }))).toBeNull();
    // The switch submits "true", not a checkbox's "on".
    expect(parseMtlsConfig(form({ mtlsPresent: '1', mtlsEnabled: 'on' }))).toBeNull();
  });

  it('keeps only positive ids and reads empty path lists as null', () => {
    expect(
      parseMtlsConfig(
        form({
          mtlsPresent: '1',
          mtlsEnabled: 'true',
          mtlsCertId: ['3', 'x', '0', '5'],
          mtlsRoleId: ['-1', '2'],
          mtlsProtectedPaths: '/admin/*',
          mtlsExcludedPaths: '',
        }),
      ),
    ).toEqual({
      enabled: true,
      trusted_client_cert_ids: [3, 5],
      trusted_role_ids: [2],
      protected_paths: ['/admin/*'],
      excluded_paths: null,
    });
  });
});

describe('the JSON rule lists', () => {
  it('keeps only redirects with a from, a to and a redirect status', () => {
    expect(
      parseRedirectsConfig(
        form({
          redirectsJson: JSON.stringify([
            { from: '/old', to: '/new', status: 301 },
            { from: '/tmp', to: '/x', status: 308 },
            { from: '/bad', to: '/x', status: 200 },
            { from: '/missing-to', status: 302 },
            null,
          ]),
        }),
      ),
    ).toEqual([
      { from: '/old', to: '/new', status: 301 },
      { from: '/tmp', to: '/x', status: 308 },
    ]);
  });

  it('keeps path blocks with an offered status, allows and rewrites with their fields', () => {
    expect(
      parsePathBlocksConfig(
        form({
          pathBlocksJson: JSON.stringify([
            { path: '/dns-query', status: 403, body: 'no' },
            { path: '/x', status: 302 },
            { path: '/y', status: '404' },
          ]),
        }),
      ),
    ).toEqual([{ path: '/dns-query', status: 403, body: 'no' }]);
    expect(
      parsePathAllowsConfig(
        form({ pathAllowsJson: JSON.stringify([{ path: '/api/*' }, { path: '  ' }, {}]) }),
      ),
    ).toEqual([{ path: '/api/*' }]);
    expect(
      parsePathRewritesConfig(
        form({
          pathRewritesJson: JSON.stringify([{ from: '/secret', to: '/dns-query' }, { from: '/x' }]),
        }),
      ),
    ).toEqual([{ from: '/secret', to: '/dns-query' }]);
  });

  it('sanitizes error pages: bodiless rules dropped, statuses limited to 4xx and 5xx', () => {
    expect(
      parseErrorPagesConfig(
        form({
          errorPagesJson: JSON.stringify([
            { statuses: [502, 503, 200, 502], body: '<h1>Down</h1>' },
            { statuses: [404], body: '' },
          ]),
        }),
      ),
    ).toEqual([{ statuses: [502, 503], body: '<h1>Down</h1>' }]);
  });

  it('passes location rules through for the model to check', () => {
    const rules = [{ path: '/api/*', upstreams: ['api:80'] }];
    expect(parseLocationRulesConfig(form({ locationRulesJson: JSON.stringify(rules) }))).toEqual(
      rules as never,
    );
  });

  it.each([
    ['redirectsJson', parseRedirectsConfig],
    ['pathBlocksJson', parsePathBlocksConfig],
    ['pathAllowsJson', parsePathAllowsConfig],
    ['pathRewritesJson', parsePathRewritesConfig],
    ['errorPagesJson', parseErrorPagesConfig],
    ['locationRulesJson', parseLocationRulesConfig],
  ] as const)('reads %s as null when missing, malformed or not a list', (key, parse) => {
    const run = parse as (data: FormData) => unknown;
    expect(run(form())).toBeNull();
    expect(run(form({ [key]: '[{"from":' }))).toBeNull();
    if (key !== 'errorPagesJson') expect(run(form({ [key]: '{"from":"/a"}' }))).toBeNull();
  });
});

describe('parseRewriteConfig', () => {
  it('trims the prefix and reads a blank one as none', () => {
    expect(parseRewriteConfig(form({ rewritePathPrefix: ' /app ' }))).toEqual({
      path_prefix: '/app',
    });
    expect(parseRewriteConfig(form({ rewritePathPrefix: '  ' }))).toBeNull();
    expect(parseRewriteConfig(form())).toBeNull();
  });
});

describe('the per-host cards', () => {
  it('reads cache as off, on or untouched', () => {
    expect(parseCacheConfig(form())).toBeUndefined();
    expect(parseCacheConfig(form({ cachePresent: '1', cacheMode: 'shared' }))).toBeNull();
    expect(
      parseCacheConfig(
        form({ cachePresent: '1', cacheEnabled: 'on', cacheMode: 'bogus', cacheMaxAge: '600' }),
      ),
    ).toEqual({ mode: 'browser', maxAge: 600 });
  });

  it('reads compression as a known mode, falling back to inherit', () => {
    expect(parseCompressionMode(form())).toBeUndefined();
    expect(parseCompressionMode(form({ compression: 'off' }))).toBe('off');
    expect(parseCompressionMode(form({ compression: 'brotli-only' }))).toBe('inherit');
  });

  it('reads maintenance, splitting bypass ranges and normalizing line endings', () => {
    expect(parseMaintenanceConfig(form({ maintenanceEnabled: 'on' }))).toBeUndefined();
    expect(
      parseMaintenanceConfig(
        form({
          maintenancePresent: '1',
          maintenanceEnabled: 'on',
          maintenanceRetryAfter: '120',
          maintenanceBypass: '10.0.0.0/8, 192.0.2.1\n2001:db8::/32',
          maintenanceBody: '<p>Back soon</p>\r\n<p>Really</p>',
        }),
      ),
    ).toEqual({
      enabled: true,
      retryAfter: 120,
      bypassCidrs: ['10.0.0.0/8', '192.0.2.1', '2001:db8::/32'],
      body: '<p>Back soon</p>\n<p>Really</p>',
    });
    expect(parseMaintenanceConfig(form({ maintenancePresent: '1' }))).toEqual({
      enabled: false,
      retryAfter: null,
      bypassCidrs: [],
      body: null,
    });
  });

  it('reads upstream timeouts as off, or one value per key', () => {
    expect(parseUpstreamTimeoutsConfig(form())).toBeUndefined();
    expect(parseUpstreamTimeoutsConfig(form({ upstreamTimeoutsPresent: '1' }))).toBeNull();
    expect(
      parseUpstreamTimeoutsConfig(
        form({
          upstreamTimeoutsPresent: '1',
          upstreamTimeoutsEnabled: 'on',
          'upstreamTimeouts.dialTimeout': ' 5s ',
          'upstreamTimeouts.readTimeout': '',
        }),
      ),
    ).toEqual({
      dialTimeout: '5s',
      responseHeaderTimeout: null,
      readTimeout: null,
      writeTimeout: null,
      keepAliveIdleTimeout: null,
      streamTimeout: null,
      streamCloseDelay: null,
    });
  });

  it('reads rate-limit zones, a malformed list reading as none', () => {
    const zones = [{ name: 'api', events: 10, window: '1m' }];
    expect(parseRateLimitConfig(form())).toBeUndefined();
    expect(
      parseRateLimitConfig(
        form({
          rateLimitPresent: '1',
          rateLimitEnabled: 'on',
          rateLimitZonesJson: JSON.stringify(zones),
        }),
      ),
    ).toEqual({ enabled: true, zones: zones as never });
    expect(parseRateLimitConfig(form({ rateLimitPresent: '1', rateLimitZonesJson: '[{' }))).toEqual(
      { enabled: false, zones: [] },
    );
    expect(
      parseRateLimitConfig(form({ rateLimitPresent: '1', rateLimitZonesJson: '{"a":1}' })),
    ).toEqual({ enabled: false, zones: [] });
  });

  it('reads Anubis, keeping it configured while off', () => {
    expect(parseAnubisConfig(form())).toBeUndefined();
    expect(
      parseAnubisConfig(
        form({
          anubisPresent: '1',
          anubisUpstream: ' http://anubis:8923 ',
          anubisExemptPaths: '/api/*\n/.well-known/*, /feed',
        }),
      ),
    ).toEqual({
      enabled: false,
      upstream: 'http://anubis:8923',
      exemptPaths: ['/api/*', '/.well-known/*', '/feed'],
    });
    expect(parseAnubisConfig(form({ anubisPresent: '1', anubisEnabled: 'on' }))).toEqual({
      enabled: true,
      upstream: null,
      exemptPaths: [],
    });
  });

  it('reads CrowdSec only when its card was rendered', () => {
    expect(parseCrowdSecEnabled(form({ crowdsecEnabled: 'on' }))).toBeUndefined();
    expect(parseCrowdSecEnabled(form({ crowdsecPresent: '1' }))).toBe(false);
    expect(parseCrowdSecEnabled(form({ crowdsecPresent: '1', crowdsecEnabled: 'on' }))).toBe(true);
  });
});

describe('parseProxyHostOptionUpdates', () => {
  it('leaves every option untouched for a form that renders none', () => {
    const updates = parseProxyHostOptionUpdates(form());
    expect(Object.entries(updates).filter(([, value]) => value !== undefined)).toEqual([]);
  });

  it('reads a rendered geoblock section, even an emptied one', () => {
    const updates = parseProxyHostOptionUpdates(form({ geoblockPresent: '1' }));
    expect(updates.geoblock).toMatchObject({ enabled: false, block_countries: [] });
    expect(updates.geoblockMode).toBe('merge');
  });

  it('reads the toggles by their markers and the raw fields by presence', () => {
    const updates = parseProxyHostOptionUpdates(
      form({
        sslForcedPresent: '1',
        hstsEnabledPresent: '1',
        hstsEnabled: 'on',
        hstsSubdomainsPresent: '1',
        allowWebsocketPresent: '1',
        allowWebsocket: 'true',
        preserveHostHeaderPresent: '1',
        skipHttpsHostnameValidationPresent: '1',
        skipHttpsHostnameValidation: '1',
        discourageIndexingPresent: '1',
        discourageIndexing: 'on',
        customPreHandlersJson: '  ',
        customCaddyfile: 'respond "hi"',
      }),
    );
    expect(updates).toMatchObject({
      sslForced: false,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: false,
      skipHttpsHostnameValidation: true,
      discourageIndexing: true,
      customPreHandlersJson: null,
      customCaddyfile: 'respond "hi"',
    });
    expect(updates.customReverseProxyJson).toBeUndefined();
  });

  it('reads a rendered but emptied rule list as a clear, not as untouched', () => {
    const updates = parseProxyHostOptionUpdates(
      form({
        mtlsPresent: '1',
        redirectsJson: '',
        rewritePathPrefix: '',
        locationRulesJson: '',
        pathAllowsJson: '[]',
        pathBlocksJson: '',
        pathRewritesJson: '',
        errorPagesJson: '',
      }),
    );
    expect(updates).toMatchObject({
      mtls: null,
      redirects: null,
      rewrite: null,
      locationRules: null,
      pathAllows: [],
      pathBlocks: null,
      pathRewrites: null,
      errorPages: null,
    });
  });
});
