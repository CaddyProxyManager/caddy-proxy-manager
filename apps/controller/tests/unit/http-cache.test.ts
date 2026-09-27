/** Storage and CDN settings for the Caddy cache: what is refused, and the `cache` app emitted. */
import { describe, expect, it } from 'bun:test';
import {
  buildHttpCacheApp,
  DEFAULT_HTTP_CACHE_SETTINGS,
  encryptHttpCacheSecrets,
  type HttpCacheSettings,
  keepStoredSecrets,
  normalizeHttpCacheSettings,
  redactHttpCacheSettings,
} from '@/src/lib/http-cache';
import { isEncryptedSecret } from '@/src/lib/secret';
import { validateSettingsGroup } from '@/src/lib/settings-validation';
import { CADDY_MODULES } from '@/src/lib/caddy-modules';

const settings = (patch: Record<string, unknown>): HttpCacheSettings =>
  normalizeHttpCacheSettings({ ...DEFAULT_HTTP_CACHE_SETTINGS, ...patch });
const all = () => true;

describe('normalizeHttpCacheSettings', () => {
  it('defaults to memory with no CDN', () => {
    expect(normalizeHttpCacheSettings({})).toEqual(DEFAULT_HTTP_CACHE_SETTINGS);
    expect(normalizeHttpCacheSettings({ storage: 'nats' }).storage).toBe('memory');
  });

  it('reads newline or comma separated addresses and drops duplicates', () => {
    const redis = settings({ storage: 'redis', redis: { addresses: 'a:1\nb:2, a:1' } }).redis;
    expect(redis.addresses).toEqual(['a:1', 'b:2']);
  });

  it.each([
    'redis',
    'redis:0',
    'redis:70000',
    'redis:6379\nextra:1 bad',
    'redis:6379"}',
    'http://redis:6379',
    '-redis:6379',
  ])('refuses the Redis address %p', (address) => {
    expect(() => settings({ storage: 'redis', redis: { addresses: [address] } })).toThrow();
  });

  it('accepts IPv6 and etcd URLs', () => {
    expect(
      settings({ storage: 'redis', redis: { addresses: ['[::1]:6379'] } }).redis.addresses,
    ).toEqual(['[::1]:6379']);
    expect(
      settings({ storage: 'etcd', etcd: { endpoints: ['https://etcd:2379'] } }).etcd.endpoints,
    ).toEqual(['https://etcd:2379']);
  });

  it('caps the address list', () => {
    const addresses = Array.from({ length: 17 }, (_, i) => `r${i}:6379`);
    expect(() => settings({ storage: 'redis', redis: { addresses } })).toThrow(/at most 16/);
  });

  it('needs a server for the network storages', () => {
    expect(() => settings({ storage: 'redis' })).toThrow(/Redis storage needs/);
    expect(() => settings({ storage: 'etcd' })).toThrow(/etcd storage needs/);
  });

  it('refuses control characters in secrets and bad identifiers', () => {
    const base = { storage: 'redis', redis: { addresses: ['r:1'] } };
    expect(() => settings({ ...base, redis: { addresses: ['r:1'], password: 'a\nb' } })).toThrow();
    expect(() => settings({ ...base, redis: { addresses: ['r:1'], username: 'a b' } })).toThrow();
    expect(() => settings({ ...base, redis: { addresses: ['r:1'], db: 256 } })).toThrow();
    expect(() => settings({ otterSize: 5 })).toThrow();
  });

  it('names what a CDN is missing in words, not field ids', () => {
    expect(() => settings({ cdn: { provider: 'cloudflare', apiKey: 'k' } })).toThrow(
      'Cloudflare purging needs the account email.',
    );
    expect(() =>
      settings({ cdn: { provider: 'cloudflare', apiKey: 'k', email: 'a@b.c' } }),
    ).toThrow('Cloudflare purging needs the zone ID.');
    expect(() => settings({ cdn: { provider: 'fastly', serviceId: 's' } })).toThrow(
      'Fastly purging needs an API token.',
    );
    expect(() => settings({ storage: 'redis', redis: { addresses: ['r:1'], db: 256 } })).toThrow(
      'The Redis database number must be a whole number from 0 to 255.',
    );
    expect(() =>
      settings({ cdn: { provider: 'cloudflare', apiKey: 'k', email: 'a@b.c', zoneId: 'z/..' } }),
    ).toThrow();
  });
});

describe('secrets', () => {
  it('keeps a stored secret when the form sends it blank', () => {
    const stored = settings({
      storage: 'redis',
      redis: { addresses: ['r:1'], password: 'old' },
      cdn: { provider: 'fastly', apiKey: 'key', serviceId: 's' },
    });
    const submitted = normalizeHttpCacheSettings({
      storage: 'redis',
      redis: { addresses: ['r:1'] },
      cdn: { provider: 'fastly', serviceId: 's', apiKey: 'x' },
    });
    const kept = keepStoredSecrets({ ...submitted, cdn: { ...submitted.cdn, apiKey: '' } }, stored);
    expect(kept.redis.password).toBe('old');
    expect(kept.cdn.apiKey).toBe('key');
  });

  it('drops a stored secret with the storage or provider it belonged to', () => {
    const stored = settings({
      storage: 'redis',
      redis: { addresses: ['r:1'], password: 'old' },
      cdn: { provider: 'fastly', apiKey: 'key', serviceId: 's' },
    });
    const switched = normalizeHttpCacheSettings(
      {
        storage: 'otter',
        cdn: { provider: 'cloudflare', email: 'a@b.cd', zoneId: 'z' },
      },
      { secretsPending: true },
    );
    const kept = keepStoredSecrets(switched, stored);
    expect(kept.redis.password).toBe('');
    expect(kept.cdn.apiKey).toBe('');
    expect(keepStoredSecrets(settings({}), stored).cdn.apiKey).toBe('');
  });

  it('keeps the Redis password only for the same servers, so it cannot be sent elsewhere', () => {
    const stored = settings({
      storage: 'redis',
      redis: { addresses: ['r1:6379', 'r2:6379'], password: 'old' },
    });
    const resubmit = (addresses: string[]) =>
      keepStoredSecrets(settings({ storage: 'redis', redis: { addresses } }), stored).redis
        .password;
    expect(resubmit(['r2:6379', 'r1:6379'])).toBe('old');
    expect(resubmit(['elsewhere:6379'])).toBe('');
    expect(resubmit(['r1:6379'])).toBe('');
  });

  it('encrypts both at rest and never shows them', () => {
    const value = settings({
      storage: 'redis',
      redis: { addresses: ['r:1'], password: 'pw' },
      cdn: { provider: 'fastly', apiKey: 'key', serviceId: 's' },
    });
    const sealed = encryptHttpCacheSecrets(value);
    expect(isEncryptedSecret(sealed.redis.password)).toBe(true);
    expect(isEncryptedSecret(sealed.cdn.apiKey)).toBe(true);
    const view = JSON.stringify(redactHttpCacheSettings(sealed));
    expect(view).not.toContain('enc:v1:');
    expect(view).toContain('"hasPassword":true');
    expect(view).toContain('"hasApiKey":true');
  });
});

describe('buildHttpCacheApp', () => {
  it('says nothing for the default, so a global Caddyfile cache block still applies', () => {
    expect(buildHttpCacheApp(DEFAULT_HTTP_CACHE_SETTINGS, all)).toBeNull();
    expect(buildHttpCacheApp(null, all)).toBeNull();
  });

  it('marks every storage found, or Souin ignores it', () => {
    const shapes: Record<string, unknown> = {
      otter: { found: true, configuration: { size: 5000 } },
      badger: { found: true, path: '/data/souin/badger' },
      simplefs: { found: true, path: '/data/souin/simplefs' },
      etcd: { found: true, url: 'e1:2379,e2:2379' },
    };
    const input: Record<string, Record<string, unknown>> = {
      otter: { storage: 'otter', otterSize: 5000 },
      badger: { storage: 'badger' },
      simplefs: { storage: 'simplefs' },
      etcd: { storage: 'etcd', etcd: { endpoints: ['e1:2379', 'e2:2379'] } },
    };
    for (const [storage, shape] of Object.entries(shapes)) {
      expect(buildHttpCacheApp(settings(input[storage]), all)).toEqual({ [storage]: shape });
    }
  });

  it('gives Redis the client name cache-handler expects, and the decrypted password', () => {
    const app = buildHttpCacheApp(
      encryptHttpCacheSecrets(
        settings({
          storage: 'redis',
          redis: { addresses: ['r:6379'], username: 'cpm', password: 'pw', db: 3 },
        }),
      ),
      all,
    );
    expect(app).toEqual({
      redis: {
        found: true,
        configuration: {
          InitAddress: ['r:6379'],
          SelectDB: 3,
          ClientName: 'souin-redis',
          Username: 'cpm',
          Password: 'pw',
        },
      },
    });
  });

  it('leaves out a storage that is not compiled in, keeping the CDN', () => {
    const app = buildHttpCacheApp(
      settings({
        storage: 'badger',
        cdn: { provider: 'cloudflare', apiKey: 'k', email: 'a@b.c', zoneId: 'zone' },
      }),
      () => false,
    );
    expect(app).toEqual({
      cdn: { provider: 'cloudflare', api_key: 'k', email: 'a@b.c', zone_id: 'zone' },
    });
  });

  it('sends Fastly its strategy', () => {
    const app = buildHttpCacheApp(
      settings({ cdn: { provider: 'fastly', apiKey: 'k', serviceId: 'svc', strategy: 'hard' } }),
      all,
    );
    expect(app).toEqual({
      cdn: { provider: 'fastly', api_key: 'k', service_id: 'svc', strategy: 'hard' },
    });
  });
});

describe('the REST group', () => {
  it('turns a model refusal into a validation error and accepts the GET shape back', () => {
    expect(() => validateSettingsGroup('http-cache', { storage: 'redis' })).toThrow(
      /Redis storage needs/,
    );
    expect(() => validateSettingsGroup('http-cache', { storage: 'nats' })).toThrow(/one of/);
    expect(() => validateSettingsGroup('http-cache', { extra: 1 })).toThrow();
    const view = redactHttpCacheSettings(DEFAULT_HTTP_CACHE_SETTINGS);
    expect(() => validateSettingsGroup('http-cache', view)).not.toThrow();
  });
});

describe('storage modules', () => {
  it('offers one opt-in module per storage besides memory', () => {
    const storages = CADDY_MODULES.filter((m) => m.cacheStorage).map((m) => m.cacheStorage);
    expect(storages.sort()).toEqual(['badger', 'etcd', 'otter', 'redis', 'simplefs']);
    expect(
      CADDY_MODULES.filter((m) => m.cacheStorage).every((m) => m.defaultEnabled === false),
    ).toBe(true);
  });
});
