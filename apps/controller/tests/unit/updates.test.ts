/**
 * Release comparison, registry-path parsing, and what the check reports. Prerelease rules are
 * easy to get backwards: 3.0.0-beta.2 precedes 3.0.0, or the beta just left reads as an update.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { version as DECLARED_VERSION } from '@/package.json';
import { vi } from '@/tests/helpers/vi';

/**
 * Test-set cache row and settings, hoisted: the mock factories close over them and a Bun
 * mock factory runs before anything a test could assign.
 */
const store = vi.hoisted(() => ({
  cache: null as unknown,
  enabled: true,
  repository: 'ghcr.io/owner/name',
}));

// lib/runtime/updates imports lib/settings for its cache, which reaches the database at module load.
vi.mock('@/src/lib/settings', () => ({
  getSetting: async () => store.cache,
  setSetting: async (_key: string, value: unknown) => {
    store.cache = value;
  },
}));

// settings/registry stays real, so these tests answer with the actual setting definitions.
vi.mock('@/src/lib/settings/resolve', () => ({
  // By `name`, not `key`: the key carries a namespace prefix the registry owns.
  getSetting: async (definition: { name: string }) =>
    definition.name === 'update_check_enabled' ? store.enabled : store.repository,
}));

const {
  compareSemver,
  getUpdateStatus,
  isNewer,
  newestRelease,
  nextPageUrl,
  parseRepository,
  parseSemver,
  tokenRealmUrl,
} = await import('@/src/lib/runtime/updates');

beforeEach(() => {
  store.cache = null;
  store.enabled = true;
  store.repository = 'ghcr.io/owner/name';
});

/** The tag list ghcr.io actually returns for this project, verified against the live registry. */
const REAL_TAGS = ['3.0.0-beta.1', 'latest', 'sha-c570c7c', '3.0.0-beta.2', 'sha-cab2ee5'];

describe('release tags', () => {
  it('accepts a release and rejects the moving aliases beside it', () => {
    expect(parseSemver('3.0.0')).toMatchObject({ major: 3, minor: 0, patch: 0, prerelease: [] });
    expect(parseSemver('v3.1.4')).toMatchObject({ major: 3, minor: 1, patch: 4 });
    expect(parseSemver('3.0.0-beta.2')).toMatchObject({ prerelease: ['beta', '2'] });

    // All published by the same build, and none of them names a comparable version.
    for (const alias of ['latest', 'main', '3', '3.0', 'sha-cab2ee5', 'develop']) {
      expect(parseSemver(alias)).toBeNull();
    }
  });

  it('picks the newest release out of a real tag list', () => {
    expect(newestRelease(REAL_TAGS)).toBe('3.0.0-beta.2');
  });

  it('returns nothing when a repository has no releases yet', () => {
    expect(newestRelease(['latest', 'sha-abc1234'])).toBeNull();
    expect(newestRelease([])).toBeNull();
  });
});

describe('version precedence', () => {
  const order = (a: string, b: string) =>
    Math.sign(compareSemver(parseSemver(a)!, parseSemver(b)!));

  it('orders by major, then minor, then patch', () => {
    expect(order('4.0.0', '3.9.9')).toBe(1);
    expect(order('3.1.0', '3.0.9')).toBe(1);
    expect(order('3.0.2', '3.0.10')).toBe(-1); // numeric, not lexical
    expect(order('3.0.0', '3.0.0')).toBe(0);
  });

  it('puts a prerelease below the release it leads to', () => {
    expect(order('3.0.0-beta.2', '3.0.0')).toBe(-1);
    expect(order('3.0.0', '3.0.0-beta.2')).toBe(1);
  });

  it('orders prerelease identifiers by semver rules', () => {
    expect(order('3.0.0-beta.2', '3.0.0-beta.10')).toBe(-1); // numeric identifiers compare numerically
    expect(order('3.0.0-alpha.1', '3.0.0-beta.1')).toBe(-1);
    expect(order('3.0.0-beta', '3.0.0-beta.1')).toBe(-1); // fewer fields sorts first
    expect(order('3.0.0-1', '3.0.0-alpha')).toBe(-1); // numeric below alphanumeric
  });
});

describe('deciding whether to tell the operator', () => {
  it('reports an update only when the registry is genuinely ahead', () => {
    expect(isNewer('3.0.0', '3.0.1')).toBe(true);
    expect(isNewer('3.0.0-beta.2', '3.0.0')).toBe(true);
    expect(isNewer('3.0.0', '3.0.0')).toBe(false);
    // The running build is ahead of anything published - a dev or locally built image.
    expect(isNewer('3.1.0', '3.0.0')).toBe(false);
  });

  it('stays quiet when the comparison cannot be made', () => {
    // A wrong "yes" sends someone chasing an update that does not exist, so every unknown is a no.
    expect(isNewer('unknown', '3.0.0')).toBe(false);
    expect(isNewer('3.0.0', null)).toBe(false);
    expect(isNewer('3.0.0', 'latest')).toBe(false);
  });

  it('is quiet for this build against the registry as it stands', () => {
    // Read from package.json rather than restated, so a release bump cannot leave this asserting
    // about a version nothing ships.
    expect(isNewer(DECLARED_VERSION, newestRelease(REAL_TAGS))).toBe(false);
  });
});

describe('the repository setting', () => {
  it('accepts a registry path, with or without a scheme or trailing slash', () => {
    expect(parseRepository('ghcr.io/silentspud/caddy-proxy-manager')).toEqual({
      host: 'ghcr.io',
      path: 'silentspud/caddy-proxy-manager',
    });
    expect(parseRepository('ghcr.io/somerandomuser/caddy-proxy-manager')).toEqual({
      host: 'ghcr.io',
      path: 'somerandomuser/caddy-proxy-manager',
    });
    expect(parseRepository('https://ghcr.io/owner/name/')).toEqual({
      host: 'ghcr.io',
      path: 'owner/name',
    });
    expect(parseRepository('registry.example.com:5000/team/app')).toMatchObject({
      host: 'registry.example.com:5000',
    });
  });

  it('refuses anything that is not a registry reference', () => {
    // This becomes a URL the server fetches, so a shape it cannot vouch for is refused outright.
    for (const bad of ['', 'ghcr.io', 'file:///etc/passwd', 'ghcr.io/UPPER/case', 'a b/c']) {
      expect(parseRepository(bad)).toBeNull();
    }
  });
});

describe('following registry pagination', () => {
  it('follows a relative next link, which is what a registry actually sends', () => {
    expect(nextPageUrl('</v2/owner/name/tags/list?n=100&last=3.0.0>; rel="next"', 'ghcr.io')).toBe(
      'https://ghcr.io/v2/owner/name/tags/list?n=100&last=3.0.0',
    );
  });

  it('follows an absolute link that stays on the same registry', () => {
    const header = '<https://ghcr.io/v2/owner/name/tags/list?last=3.0.0>; rel="next"';
    expect(nextPageUrl(header, 'ghcr.io')).toBe(
      'https://ghcr.io/v2/owner/name/tags/list?last=3.0.0',
    );
  });

  it('refuses a link to another host rather than fetching it', () => {
    // new URL(value, base) ignores the base for an absolute value, which would be a server-side
    // fetch of whatever the registry named, carrying the caller's bearer token.
    expect(() =>
      nextPageUrl('<http://169.254.169.254/latest/meta-data/>; rel="next"', 'ghcr.io'),
    ).toThrow(/will not follow/);
  });

  it('names both origins, since the message is what the operator is shown', () => {
    expect(() =>
      nextPageUrl('<http://169.254.169.254/latest/meta-data/>; rel="next"', 'ghcr.io'),
    ).toThrow('The registry paginated to http://169.254.169.254, not https://ghcr.io');
  });

  it('refuses a link that downgrades to http on the same host', () => {
    expect(() =>
      nextPageUrl('<http://ghcr.io/v2/owner/name/tags/list>; rel="next"', 'ghcr.io'),
    ).toThrow(/will not follow/);
  });

  it('refuses a link to a different port on the same host', () => {
    expect(() =>
      nextPageUrl('<https://registry.test:8443/v2/x/tags/list>; rel="next"', 'registry.test'),
    ).toThrow(/will not follow/);
  });

  it('keeps the port when the registry itself has one', () => {
    expect(nextPageUrl('</v2/x/tags/list?last=1>; rel="next"', 'registry.test:5000')).toBe(
      'https://registry.test:5000/v2/x/tags/list?last=1',
    );
  });

  it('stops when there is no next page', () => {
    expect(nextPageUrl(null, 'ghcr.io')).toBeNull();
    expect(nextPageUrl('</v2/x/tags/list>; rel="prev"', 'ghcr.io')).toBeNull();
  });
});

describe('following the registry auth challenge', () => {
  it('follows a realm on the registry itself, which is what ghcr.io sends', () => {
    expect(tokenRealmUrl('https://ghcr.io/token', 'ghcr.io').toString()).toBe(
      'https://ghcr.io/token',
    );
  });

  it('follows the token service Docker Hub is known to use', () => {
    expect(tokenRealmUrl('https://auth.docker.io/token', 'registry-1.docker.io').hostname).toBe(
      'auth.docker.io',
    );
  });

  it('refuses a realm on another host rather than fetching it', () => {
    expect(() => tokenRealmUrl('https://169.254.169.254/latest/meta-data', 'ghcr.io')).toThrow(
      /will not follow/,
    );
  });

  it('does not lend one registry the token service of another', () => {
    expect(() => tokenRealmUrl('https://auth.docker.io/token', 'ghcr.io')).toThrow(
      /will not follow/,
    );
  });

  it('refuses a realm that downgrades to http on the same host', () => {
    expect(() => tokenRealmUrl('http://ghcr.io/token', 'ghcr.io')).toThrow(/will not follow/);
  });

  it('refuses a known token service on another port', () => {
    expect(() => tokenRealmUrl('https://auth.docker.io:8443/token', 'docker.io')).toThrow(
      /will not follow/,
    );
  });

  it('refuses a realm that is not an absolute URL', () => {
    expect(() => tokenRealmUrl('/token', 'ghcr.io')).toThrow(/not a URL/);
  });
});

describe('what the status reports', () => {
  const CACHED = {
    checkedAt: '2026-01-01T00:00:00.000Z',
    latest: '9.9.9',
    error: null,
    repository: 'ghcr.io/owner/name',
  };

  it('serves the cached answer while checks are on', async () => {
    // False regardless: APP_VERSION is not baked into a test build, and an unknown version never
    // announces anything.
    store.cache = CACHED;

    const status = await getUpdateStatus();
    expect(status).toMatchObject({
      enabled: true,
      latest: '9.9.9',
      checkedAt: CACHED.checkedAt,
    });
  });

  it('knows nothing while checks are off, rather than repeating a stale answer', async () => {
    // The Settings page reads `latest` as authoritative, and "Check now" is disabled with the
    // setting, so a stale value could never be refreshed.
    store.cache = CACHED;
    store.enabled = false;

    const status = await getUpdateStatus();
    expect(status).toMatchObject({
      enabled: false,
      latest: null,
      checkedAt: null,
      error: null,
      updateAvailable: false,
    });
  });

  it('still names the repository while checks are off, since the field shows it', async () => {
    store.enabled = false;
    store.repository = 'ghcr.io/fork/name';

    expect((await getUpdateStatus()).repository).toBe('ghcr.io/fork/name');
  });

  it('ignores a cached answer for a repository that has since been changed', async () => {
    store.cache = CACHED;
    store.repository = 'ghcr.io/fork/name';

    const status = await getUpdateStatus();
    expect(status.latest).toBeNull();
    expect(status.checkedAt).toBeNull();
  });
});
