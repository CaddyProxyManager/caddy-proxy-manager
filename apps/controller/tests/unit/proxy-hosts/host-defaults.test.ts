import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_HOST_DEFAULTS,
  applyL4ProxyHostDefaults,
  applyProxyHostDefaults,
  isStockHostDefaults,
  normalizeHostDefaults,
  sanitizeHostDefaults,
  wafOnByDefault,
} from '@/src/lib/proxy-hosts/host-defaults';
import { validateSettingsGroup } from '@/src/lib/settings/validation';

describe('sanitizeHostDefaults', () => {
  it('reads anything unreadable as the shipped values', () => {
    for (const stored of [null, undefined, 'x', 42, [], {}]) {
      expect(sanitizeHostDefaults(stored)).toEqual(DEFAULT_HOST_DEFAULTS);
    }
  });

  it('keeps readable fields and replaces unreadable ones, field by field', () => {
    const result = sanitizeHostDefaults({
      proxyHost: { sslForced: false, hstsEnabled: 'yes', compression: 'gzip', wafEnabled: true },
      l4ProxyHost: { protocol: 'sctp', proxyProtocolReceive: true },
      extra: true,
    });
    // A stored WAF choice is ignored: the default follows the global WAF instead.
    expect(result.proxyHost).toEqual({ ...DEFAULT_HOST_DEFAULTS.proxyHost, sslForced: false });
    expect(result.l4ProxyHost).toEqual({
      ...DEFAULT_HOST_DEFAULTS.l4ProxyHost,
      proxyProtocolReceive: true,
    });
    expect(result).not.toHaveProperty('extra');
  });

  it('keeps a stored combination normalize would refuse to write', () => {
    // Read as stored: only a write is normalized, so the form shows what is there.
    const stored = { proxyHost: { sslForced: false, hstsEnabled: true } };
    expect(sanitizeHostDefaults(stored).proxyHost.hstsEnabled).toBe(true);
  });
});

describe('normalizeHostDefaults', () => {
  it('drops HSTS without forced HTTPS, and subdomains without HSTS', () => {
    const noHttps = normalizeHostDefaults({
      proxyHost: { sslForced: false, hstsEnabled: true, hstsSubdomains: true },
    });
    expect(noHttps.proxyHost).toMatchObject({ hstsEnabled: false, hstsSubdomains: false });
    const noHsts = normalizeHostDefaults({
      proxyHost: { sslForced: true, hstsEnabled: false, hstsSubdomains: true },
    });
    expect(noHsts.proxyHost.hstsSubdomains).toBe(false);
  });

  it('drops TLS termination over UDP', () => {
    const udp = normalizeHostDefaults({ l4ProxyHost: { protocol: 'udp', tlsTermination: true } });
    expect(udp.l4ProxyHost).toMatchObject({ protocol: 'udp', tlsTermination: false });
    const tcp = normalizeHostDefaults({ l4ProxyHost: { protocol: 'tcp', tlsTermination: true } });
    expect(tcp.l4ProxyHost.tlsTermination).toBe(true);
  });

  it('writes the shipped values for an empty object', () => {
    expect(normalizeHostDefaults({})).toEqual(DEFAULT_HOST_DEFAULTS);
  });
});

describe('isStockHostDefaults', () => {
  it('tells the shipped values from a changed kind, per kind', () => {
    const changed = sanitizeHostDefaults({ l4ProxyHost: { protocol: 'udp' } });
    expect(isStockHostDefaults(changed, 'proxyHost')).toBe(true);
    expect(isStockHostDefaults(changed, 'l4ProxyHost')).toBe(false);
  });
});

describe('applyProxyHostDefaults', () => {
  const body = { name: 'a', domains: ['a.example.com'], upstreams: ['app:80'] };

  it('fills what the shipped defaults always gave', () => {
    expect(applyProxyHostDefaults(body, DEFAULT_HOST_DEFAULTS.proxyHost)).toMatchObject({
      sslForced: true,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: true,
      skipHttpsHostnameValidation: false,
      discourageIndexing: false,
      compression: 'inherit',
      waf: undefined,
      crowdsec: true,
    });
  });

  it('switches the WAF on as the editor would, unless the body sets it', () => {
    const defaults = { ...DEFAULT_HOST_DEFAULTS.proxyHost, wafEnabled: true };
    expect(applyProxyHostDefaults(body, defaults).waf).toEqual({
      enabled: true,
      waf_mode: 'merge',
      load_owasp_crs: true,
    });
    expect(applyProxyHostDefaults({ ...body, waf: null }, defaults).waf).toBeNull();
  });

  it('keeps a null crowdsec, which follows the global setting', () => {
    const defaults = { ...DEFAULT_HOST_DEFAULTS.proxyHost, crowdsecEnabled: false };
    expect(applyProxyHostDefaults({ ...body, crowdsec: null }, defaults).crowdsec).toBeNull();
    expect(applyProxyHostDefaults(body, defaults).crowdsec).toBe(false);
  });
});

describe('applyL4ProxyHostDefaults', () => {
  const body = { name: 'db', listenAddress: ':5432', upstreams: ['db:5432'] };
  const defaults = {
    protocol: 'udp' as const,
    tlsTermination: true,
    proxyProtocolReceive: true,
    crowdsecEnabled: false,
  };

  it('fills the protocol and the rest when left out', () => {
    expect(applyL4ProxyHostDefaults(body as never, defaults)).toMatchObject({
      protocol: 'udp',
      tlsTermination: false,
      proxyProtocolReceive: true,
      crowdsec: false,
    });
  });

  it('terminates TLS by default only over TCP', () => {
    const tcp = applyL4ProxyHostDefaults({ ...body, protocol: 'tcp' }, defaults);
    expect(tcp.tlsTermination).toBe(true);
  });
});

describe('the host-defaults settings group', () => {
  it('takes a partial body and refuses unknown or mistyped fields', () => {
    expect(() => validateSettingsGroup('host-defaults', {})).not.toThrow();
    expect(() =>
      validateSettingsGroup('host-defaults', { proxyHost: { sslForced: false } }),
    ).not.toThrow();
    expect(() => validateSettingsGroup('host-defaults', { other: {} })).toThrow();
    expect(() =>
      validateSettingsGroup('host-defaults', { proxyHost: { sslForced: 'no' } }),
    ).toThrow();
    expect(() =>
      validateSettingsGroup('host-defaults', { proxyHost: { compression: 'gzip' } }),
    ).toThrow();
    expect(() =>
      validateSettingsGroup('host-defaults', { l4ProxyHost: { protocol: 'sctp' } }),
    ).toThrow();
    expect(() =>
      validateSettingsGroup('host-defaults', { l4ProxyHost: { listenAddress: ':1' } }),
    ).toThrow();
  });
});

describe('wafOnByDefault', () => {
  it('is on while the global WAF logs or blocks, and off otherwise', () => {
    expect(wafOnByDefault({ enabled: true, mode: 'On' })).toBe(true);
    expect(wafOnByDefault({ enabled: true, mode: 'DetectionOnly' })).toBe(true);
    expect(wafOnByDefault({ enabled: true, mode: 'Off' })).toBe(false);
    expect(wafOnByDefault({ enabled: false, mode: 'On' })).toBe(false);
    expect(wafOnByDefault(null)).toBe(false);
  });
});
