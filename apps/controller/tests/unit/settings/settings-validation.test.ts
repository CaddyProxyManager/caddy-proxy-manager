import { describe, expect, it } from 'bun:test';
import { DomainError } from '@/src/lib/errors/domain-error';
import { SettingsValidationError, validateSettingsGroup } from '@/src/lib/settings/validation';

function thrownBy(run: () => unknown): SettingsValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof SettingsValidationError) return error;
    throw error;
  }
  throw new Error('expected a SettingsValidationError');
}

const geoblock = {
  enabled: true,
  block_countries: ['CN'],
  block_continents: [],
  block_asns: [],
  block_cidrs: ['10.0.0.0/8'],
  block_ips: [],
  allow_countries: ['FI'],
  allow_continents: ['EU'],
  allow_asns: [64512],
  allow_cidrs: [],
  allow_ips: ['192.0.2.1'],
  trusted_proxies: ['private_ranges'],
  fail_closed: false,
  response_status: 403,
  response_body: 'Forbidden',
  response_headers: { 'Content-Type': 'text/plain' },
  redirect_url: '',
};

const validGroups: Record<string, Record<string, unknown>> = {
  general: { defaultDomain: 'example.com', acmeEmail: 'admin@example.com' },
  acme: { caUrl: 'https://ca.example.com/acme/directory' },
  cloudflare: { apiToken: 'secret', zoneId: 'zone' },
  authentik: { outpostDomain: 'auth.example.com', outpostUpstream: 'http://authentik:9000' },
  'forward-auth': { provider: 'authelia', authUpstream: 'http://authelia:9091' },
  metrics: { enabled: true, port: 9090 },
  logging: { enabled: true, format: 'json' },
  dns: { enabled: true, resolvers: ['1.1.1.1'], fallbacks: [], timeout: '5s' },
  'dns-provider': {
    providers: { cloudflare: { api_token: 'secret' } },
    default: 'cloudflare',
  },
  'upstream-dns': { enabled: true, family: 'both' },
  geoblock,
  'rate-limit': {
    enabled: true,
    zones: [{ maxEvents: 60, window: '1m', key: 'header', header: 'X-Api-Key' }],
    allowlist: ['10.0.0.0/8'],
  },
  waf: {
    enabled: true,
    mode: 'On',
    load_owasp_crs: true,
    custom_directives: '',
    excluded_rule_ids: [920350],
  },
  'error-pages': {
    rules: [{ statuses: [502, 503], body: 'Unavailable', contentType: 'text/plain' }],
  },
  'default-response': { mode: 'respond', status: 404, body: 'Not found' },
  'trusted-proxies': {
    ranges: ['private_ranges', '192.0.2.0/24'],
    client_ip_headers: ['CF-Connecting-IP'],
    strict: true,
  },
};

describe('REST settings runtime validation', () => {
  for (const [group, input] of Object.entries(validGroups)) {
    it(`accepts the documented ${group} shape`, () => {
      expect(validateSettingsGroup(group, input)).toBe(input);
    });

    it(`rejects unknown fields for ${group}`, () => {
      expect(() => validateSettingsGroup(group, { ...input, unexpected: true })).toThrow(
        SettingsValidationError,
      );
    });
  }

  // The setup screen and the dashboard render the code in the reader's language; the English
  // sentence is what /api/v1 answers with, so both travel on one error.
  it('carries a code and params beside the English sentence', () => {
    const unknownField = thrownBy(() =>
      validateSettingsGroup('metrics', { enabled: true, injected: 1 }),
    );
    expect(unknownField).toBeInstanceOf(DomainError);
    expect(unknownField.status).toBe(400);
    expect(unknownField.code).toBe('settingsUnknownField');
    expect(unknownField.params).toEqual({ field: 'metrics settings', key: 'injected' });
    expect(unknownField.message).toBe('metrics settings contains unknown field: injected');

    const tooShort = thrownBy(() =>
      validateSettingsGroup('dashboard', { enabled: true, domain: '', tls: true }),
    );
    expect(tooShort.code).toBe('settingsFieldLength');
    expect(tooShort.params).toEqual({ field: 'dashboard.domain', min: 1, max: 253 });
    expect(tooShort.message).toBe('dashboard.domain must contain between 1 and 253 characters');

    const oneOf = thrownBy(() => validateSettingsGroup('waf', { ...validGroups.waf, mode: 'x' }));
    expect(oneOf.code).toBe('settingsFieldOneOf');
    expect(oneOf.params).toEqual({ field: 'waf.mode', allowed: ['Off', 'On', 'DetectionOnly'] });

    const unknownGroup = thrownBy(() => validateSettingsGroup('nope', {}));
    expect(unknownGroup.code).toBe('settingsGroupUnknown');
    expect(unknownGroup.message).toBe('Unknown settings group');
  });

  it("keeps a normalizer's own code rather than wrapping its sentence", () => {
    const error = thrownBy(() =>
      validateSettingsGroup('rate-limit', {
        enabled: true,
        zones: [{ maxEvents: 60, window: '1m', key: 'header', header: '{http.request.host}' }],
        allowlist: [],
      }),
    );
    expect(error.code).toBe('hostRateLimitHeaderInvalid');
    expect(error.status).toBe(400);
  });

  it('refuses IPv6 zone ids in trusted proxies and geoblock lists', () => {
    expect(() =>
      validateSettingsGroup('trusted-proxies', {
        ...validGroups['trusted-proxies'],
        ranges: ['fe80::%eth0/64'],
      }),
    ).toThrow(SettingsValidationError);
    expect(() =>
      validateSettingsGroup('geoblock', { ...geoblock, allow_ips: ['fe80::1%eth0'] }),
    ).toThrow(SettingsValidationError);
    expect(() =>
      validateSettingsGroup('geoblock', { ...geoblock, block_cidrs: ['fe80::1%1'] }),
    ).toThrow(SettingsValidationError);
  });

  it('rejects type confusion and out-of-range values', () => {
    expect(() => validateSettingsGroup('metrics', { enabled: 'yes', port: 70000 })).toThrow(
      /boolean/,
    );
    expect(() =>
      validateSettingsGroup('waf', {
        ...validGroups.waf,
        mode: 'On\nSecRuleEngine Off',
      }),
    ).toThrow(/waf\.mode/);
    expect(() =>
      validateSettingsGroup('geoblock', {
        ...geoblock,
        trusted_proxies: ['not-a-network'],
      }),
    ).toThrow(/IP address or CIDR/);
    expect(() =>
      validateSettingsGroup('rate-limit', {
        enabled: true,
        zones: [{ maxEvents: 60, window: '1m', key: 'header', header: '{http.request.host}' }],
        allowlist: [],
      }),
    ).toThrow(SettingsValidationError);
  });

  // Coraza rejects a body limit above 1 GiB while Caddy loads the config, which
  // takes down the whole document - so it has to fail at save time, with a
  // message that says which value is wrong.
  it('rejects WAF body limits Coraza would refuse', () => {
    expect(() =>
      validateSettingsGroup('waf', {
        ...validGroups.waf,
        request_body_limit: 10737418240,
      }),
    ).toThrow(/waf\.request_body_limit must be an integer between/);
    expect(() =>
      validateSettingsGroup('waf', {
        ...validGroups.waf,
        request_body_limit: 1048576,
        request_body_in_memory_limit: 2097152,
      }),
    ).toThrow(/must not exceed/);
    expect(() =>
      validateSettingsGroup('waf', {
        ...validGroups.waf,
        request_body_limit_action: 'Drop',
      }),
    ).toThrow(/request_body_limit_action must be one of: Reject, ProcessPartial/);
    expect(() =>
      validateSettingsGroup('waf', {
        ...validGroups.waf,
        custom_directives: 'SecRequestBodyLimit 10737418240',
      }),
    ).toThrow(/out-of-range body limit/);
    expect(() =>
      validateSettingsGroup('waf', {
        ...validGroups.waf,
        strict_directives: true,
        custom_directives: 'SecRuleUpdateActionById 9001 "deny"',
      }),
    ).toThrow(/would be dropped and never sent to Caddy/);
  });

  it('only rejects WAF directive lines an update newly drops', () => {
    const legacy = 'SecRule ARGS "@pmFromFile /etc/hosts" "id:1,deny"';
    const strict = { ...validGroups.waf, strict_directives: true };
    const previousWaf = {
      custom_directives: legacy,
      load_owasp_crs: true,
      strict_directives: true,
    };
    expect(() => validateSettingsGroup('waf', { ...strict, custom_directives: legacy })).toThrow(
      /would be dropped/,
    );
    expect(() =>
      validateSettingsGroup(
        'waf',
        { ...strict, mode: 'DetectionOnly', custom_directives: legacy },
        { previousWaf },
      ),
    ).not.toThrow();
    expect(() =>
      validateSettingsGroup(
        'waf',
        {
          ...strict,
          custom_directives: `${legacy}\nSecRuleUpdateActionById 930130 "block"`,
        },
        { previousWaf },
      ),
    ).toThrow(/SecRuleUpdateActionById/);
  });

  it('sends risky WAF directives without the strict setting, but never one Coraza lacks', () => {
    const risky = 'SecRule ARGS "@pmFromFile /etc/hosts" "id:1,deny"\nSecAuditEngine Off';
    expect(() =>
      validateSettingsGroup('waf', { ...validGroups.waf, custom_directives: risky }),
    ).not.toThrow();
    expect(() =>
      validateSettingsGroup('waf', {
        ...validGroups.waf,
        strict_directives: false,
        custom_directives: risky,
      }),
    ).not.toThrow();
    expect(() =>
      validateSettingsGroup('waf', { ...validGroups.waf, custom_directives: 'SecBogus On' }),
    ).toThrow(/SecBogus is not a directive Coraza knows/);
    expect(() =>
      validateSettingsGroup('waf', { ...validGroups.waf, strict_directives: 'yes' }),
    ).toThrow(/waf\.strict_directives/);
  });

  it("accepts WAF body limits inside Coraza's range", () => {
    const input = {
      ...validGroups.waf,
      request_body_limit: 1073741824,
      request_body_in_memory_limit: 1048576,
      request_body_limit_action: 'ProcessPartial',
    };
    expect(validateSettingsGroup('waf', input)).toBe(input);
  });

  it('rejects unsupported DNS providers and credential keys', () => {
    expect(() =>
      validateSettingsGroup('dns-provider', {
        providers: { malicious: { command: 'run' } },
        default: 'malicious',
      }),
    ).toThrow(/Unsupported DNS provider/);
    expect(() =>
      validateSettingsGroup('dns-provider', {
        providers: { cloudflare: { api_token: 'secret', injected: 'value' } },
        default: 'cloudflare',
      }),
    ).toThrow(/unknown field/);
  });

  it('validates DNS challenge duration option fields', () => {
    const settings = (propagation: Record<string, unknown>) => ({
      providers: {
        netcup: {
          customer_number: '123456',
          api_key: 'secret',
          api_password: 'secret',
          ...propagation,
        },
      },
      default: 'netcup',
    });

    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({ propagation_delay: '600s', propagation_timeout: '900s' }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSettingsGroup('dns-provider', settings({ propagation_timeout: '-1' })),
    ).not.toThrow();
    expect(() =>
      validateSettingsGroup('dns-provider', settings({ propagation_delay: '600' })),
    ).toThrow(/propagation_delay must be a duration/);
    expect(() =>
      validateSettingsGroup('dns-provider', settings({ propagation_timeout: 'soon' })),
    ).toThrow(/propagation_timeout must be a duration/);
  });

  it('validates challenge delegations and acme-dns accounts', () => {
    const account = {
      username: 'user',
      password: 'secret',
      subdomain: 'sub',
      fulldomain: 'sub.auth.example.net',
      server_url: 'https://auth.example.net',
    };
    const settings = (extra: Record<string, unknown>) => ({
      providers: { cloudflare: { api_token: 'secret' }, acmedns: {} },
      default: 'cloudflare',
      ...extra,
    });

    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({
          delegations: [
            { domain: 'example.com', target: '_acme-challenge.example.com.zone.example.net' },
            { domain: 'other.example', provider: 'acmedns' },
          ],
          acmeDnsAccounts: { 'other.example': account },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({ delegations: [{ domain: '*.example.com', provider: 'cloudflare' }] }),
      ),
    ).toThrow(/without a wildcard/);
    expect(() =>
      validateSettingsGroup('dns-provider', settings({ delegations: [{ domain: 'example.com' }] })),
    ).toThrow(/needs a target, a provider or both/);
    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({ delegations: [{ domain: 'example.com', provider: 'route53' }] }),
      ),
    ).toThrow(/configured provider/);
    // A placeholder would be expanded by Caddy's replacer.
    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({ delegations: [{ domain: 'example.com', target: '{env.SECRET}.example.net' }] }),
      ),
    ).toThrow(/target must be a domain name/);
    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({
          delegations: [
            { domain: 'example.com', provider: 'cloudflare' },
            { domain: 'EXAMPLE.com', provider: 'cloudflare' },
          ],
        }),
      ),
    ).toThrow(/listed twice/);
    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({ acmeDnsAccounts: { 'example.com': { ...account, server_url: 'ftp://x' } } }),
      ),
    ).toThrow(/server_url/);
    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({ acmeDnsAccounts: { 'example.com': { ...account, extra: 'x' } } }),
      ),
    ).toThrow(/unknown field/);
    expect(() =>
      validateSettingsGroup(
        'dns-provider',
        settings({ acmeDnsAccounts: { 'Example.com': account } }),
      ),
    ).toThrow(/lowercase/);
    // The single acme-dns account is all or nothing.
    expect(() =>
      validateSettingsGroup('dns-provider', {
        providers: { acmedns: { username: 'user' } },
        default: 'acmedns',
      }),
    ).toThrow(/or none/);
  });

  it('caps total payload size', () => {
    expect(() => validateSettingsGroup('acme', { caRootPem: 'x'.repeat(1024 * 1024 + 1) })).toThrow(
      /must not exceed/,
    );
  });

  it('accepts empty optional email and multiline ACME root PEM values', () => {
    expect(
      validateSettingsGroup('general', {
        defaultDomain: 'example.com',
        acmeEmail: '',
      }),
    ).toEqual({ defaultDomain: 'example.com', acmeEmail: '' });

    const caRootPem = '-----BEGIN CERTIFICATE-----\r\nMIIB\n-----END CERTIFICATE-----\n';
    expect(validateSettingsGroup('acme', { caRootPem })).toEqual({ caRootPem });
  });

  it('validates the shape of an ACME contact address', () => {
    const withEmail = (acmeEmail: string) =>
      validateSettingsGroup('general', { defaultDomain: 'example.com', acmeEmail });

    for (const good of ['admin@example.com', 'admin@mail.example.co.uk']) {
      expect(withEmail(good), good).toEqual({ defaultDomain: 'example.com', acmeEmail: good });
    }

    for (const bad of ['admin', 'admin@example', 'admin@.com', 'admin@example.', 'a b@x.com']) {
      expect(() => withEmail(bad), bad).toThrow(/valid email address/);
    }

    // A pattern letting both sides of the dot swallow an empty label backtracks quadratically.
    expect(() => withEmail('admin@example..com')).toThrow(/valid email address/);
  });

  it('caps the address length before the pattern ever runs', () => {
    // '!@!.!.!...' is the worst case for such a pattern. The length cap, not the pattern, keeps a
    // hostile payload harmless, so it has to run before the match.
    expect(() =>
      validateSettingsGroup('general', {
        defaultDomain: 'example.com',
        acmeEmail: `!@${'!.'.repeat(5000)}`,
      }),
    ).toThrow(/between 0 and 320 characters/);
  });

  it('rejects non-line-break control characters in ACME root PEM values', () => {
    expect(() =>
      validateSettingsGroup('acme', {
        caRootPem: '-----BEGIN CERTIFICATE-----\nsecret\u0000suffix\n-----END CERTIFICATE-----',
      }),
    ).toThrow(/control characters/);
  });
});
