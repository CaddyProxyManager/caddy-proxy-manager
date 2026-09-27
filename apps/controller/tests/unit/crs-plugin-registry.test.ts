/** src/lib/crs-plugins/registry.ts against a fake GitHub; an unloadable plugin is never stored. */
import { describe, it, expect } from 'bun:test';
import {
  fetchCrsPluginRelease,
  fetchCrsRegistry,
  checkCrsPluginSupport,
  parseCrsRegistry,
  resolveCrsPluginVersion,
  withGitHubToken,
} from '../../src/lib/crs-plugins/registry';
import { DomainError } from '../../src/lib/domain-error';
import { FAKE_BOT, REGISTRY, WORDPRESS, fakeGithub } from '../helpers/fake-github';

const WORDPRESS_REPO = 'coreruleset/wordpress-rule-exclusions-plugin';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return undefined;
}

describe('parseCrsRegistry', () => {
  it('keeps installable entries, sorted, and drops private or malformed ones', () => {
    const entries = parseCrsRegistry({
      plugins: [
        ...REGISTRY.plugins,
        { name: 'no-range', repository: 'https://github.com/a/b', type: 'official' },
        {
          name: 'elsewhere',
          repository: 'https://gitlab.com/a/b',
          type: 'official',
          status: 'tested',
          rule_id_range: { start: 9530000, end: 9530999 },
        },
      ],
    });
    expect(entries.map((entry) => entry.name)).toEqual(['fake-bot', 'wordpress-rule-exclusions']);
    expect(entries[1]).toMatchObject({
      ruleIdStart: 9507000,
      ruleIdEnd: 9507999,
      type: 'official',
    });
  });

  it('reads nothing out of a document that is not a registry', () => {
    expect(parseCrsRegistry(null)).toEqual([]);
    expect(parseCrsRegistry({ plugins: 'x' })).toEqual([]);
  });
});

describe('fetchCrsRegistry', () => {
  it("reads a registry of the operator's own from its URL", async () => {
    const url = 'https://example.test/my-registry.json';
    const github = fakeGithub({}, { [url]: { plugins: [REGISTRY.plugins[0]] } });
    const entries = await fetchCrsRegistry(github.fetcher, url);
    expect(entries.map((entry) => entry.name)).toEqual(['wordpress-rule-exclusions']);
    expect(github.requested).toEqual([url]);
  });

  it('names a rate limit, which is the likely failure unauthenticated', async () => {
    const github = fakeGithub({});
    github.status.rateLimited = true;
    expect(await codeOf(fetchCrsRegistry(github.fetcher))).toBe('crsPluginRateLimited');
  });
});

describe('resolveCrsPluginVersion', () => {
  it('pins to the latest release tag', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    expect(
      await resolveCrsPluginVersion(
        { repository: `https://github.com/${WORDPRESS_REPO}` },
        github.fetcher,
      ),
    ).toBe('v1.2.0');
  });

  it("falls back to the default branch's commit for a plugin that never tagged one", async () => {
    const sha = 'a'.repeat(40);
    const github = fakeGithub({ 'x/y-plugin': { release: null, head: sha, files: {} } });
    expect(
      await resolveCrsPluginVersion(
        { repository: 'https://github.com/x/y-plugin' },
        github.fetcher,
      ),
    ).toBe(sha);
  });
});

describe('fetchCrsPluginRelease', () => {
  const [wordpress, fakeBot] = [REGISTRY.plugins[0], REGISTRY.plugins[1]].map(
    (raw) => parseCrsRegistry({ plugins: [raw] })[0],
  );

  it('reads the three files and the descriptor, from the repository alone', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const release = await fetchCrsPluginRelease(wordpress, 'v1.2.0', github.fetcher);
    expect(release.version).toBe('v1.2.0');
    expect(release.description).toBe('CRS rule exclusions for WordPress');
    expect(release.configRules).toBe('# enabled by default');
    expect(release.beforeRules).toContain('id:9507100');
    expect(release.afterRules).toBe('');
    // Files come from the listed repository, not the listing's download_url.
    expect(github.requested.some((url) => url.includes('evil.example'))).toBe(false);
  });

  it('refuses a plugin that needs a Lua script, naming the line', async () => {
    const github = fakeGithub({ 'coreruleset/fake-bot-plugin': FAKE_BOT });
    let caught: unknown;
    try {
      await fetchCrsPluginRelease(fakeBot, 'v1.1.0', github.fetcher);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('crsPluginRejected');
    expect((caught as DomainError).message).toContain('@inspectFile fake-bot.lua');
  });

  it('refuses a plugin whose descriptor excludes Coraza', async () => {
    const github = fakeGithub({
      [WORDPRESS_REPO]: {
        ...WORDPRESS,
        descriptor: 'plugin:\n  description: x\ncompatibility:\n  engines:\n    - modsecurity2\n',
      },
    });
    expect(await codeOf(fetchCrsPluginRelease(wordpress, 'v1.2.0', github.fetcher))).toBe(
      'crsPluginEngineIncompatible',
    );
  });

  it('refuses a repository without a plugins folder', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: { release: 'v9', files: {} } });
    expect(await codeOf(fetchCrsPluginRelease(wordpress, 'v9', github.fetcher))).toBe(
      'crsPluginNoRuleFiles',
    );
  });
});

describe('withGitHubToken', () => {
  it('sends the token to the GitHub API and nowhere else', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    const fetcher = withGitHubToken(github.fetcher, 'ghp_secret');
    await resolveCrsPluginVersion({ repository: `https://github.com/${WORDPRESS_REPO}` }, fetcher);
    await fetchCrsRegistry(fetcher);
    const api = Object.keys(github.headers).find((url) =>
      url.startsWith('https://api.github.com/'),
    );
    const raw = Object.keys(github.headers).find((url) => url.includes('registry.json'));
    expect(github.headers[api!].Authorization).toBe('Bearer ghp_secret');
    expect(github.headers[raw!].Authorization).toBeUndefined();
  });

  it('changes nothing without a token', () => {
    const github = fakeGithub({});
    expect(withGitHubToken(github.fetcher, null)).toBe(github.fetcher);
  });
});

describe('checkCrsPluginSupport', () => {
  const [wordpress, fakeBot] = [REGISTRY.plugins[0], REGISTRY.plugins[1]].map(
    (raw) => parseCrsRegistry({ plugins: [raw] })[0],
  );

  it('finds an installable plugin supported', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    expect(await checkCrsPluginSupport(wordpress, 'v1.2.0', github.fetcher)).toEqual({
      supported: true,
    });
  });

  it('names why a plugin cannot load, as a verdict rather than a throw', async () => {
    const github = fakeGithub({ 'coreruleset/fake-bot-plugin': FAKE_BOT });
    const verdict = await checkCrsPluginSupport(fakeBot, 'v1.1.0', github.fetcher);
    expect(verdict.supported).toBe(false);
    expect(verdict.supported === false && verdict.reason).toBe('files');
  });

  it('reports a descriptor that excludes Coraza, and a repository with no rules', async () => {
    const engine = fakeGithub({
      [WORDPRESS_REPO]: {
        ...WORDPRESS,
        descriptor: ['compatibility:', '  engines:', '    - modsecurity3', ''].join('\n'),
      },
    });
    const noRules = fakeGithub({ [WORDPRESS_REPO]: { release: 'v9', files: {} } });
    const reason = async (promise: ReturnType<typeof checkCrsPluginSupport>) => {
      const verdict = await promise;
      return verdict.supported ? null : verdict.reason;
    };
    expect(await reason(checkCrsPluginSupport(wordpress, 'v1.2.0', engine.fetcher))).toBe('engine');
    expect(await reason(checkCrsPluginSupport(wordpress, 'v9', noRules.fetcher))).toBe('noRules');
  });

  it('still throws when GitHub cannot be reached, which says nothing about the plugin', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS });
    github.status.rateLimited = true;
    expect(await codeOf(checkCrsPluginSupport(wordpress, 'v1.2.0', github.fetcher))).toBe(
      'crsPluginRateLimited',
    );
  });
});

describe('fetch hardening', () => {
  it('sends the token only to api.github.com itself, not a host that starts the same', async () => {
    const seen: Record<string, string | undefined> = {};
    const fetcher = withGitHubToken(async (input, init) => {
      seen[input] = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response('{}');
    }, 'ghp_secret');
    await fetcher('https://api.github.com.example.test/repos/a/b/releases/latest');
    await fetcher('https://api.github.com/repos/a/b/releases/latest');
    expect(seen['https://api.github.com.example.test/repos/a/b/releases/latest']).toBeUndefined();
    expect(seen['https://api.github.com/repos/a/b/releases/latest']).toBe('Bearer ghp_secret');
  });

  it('stops reading a body with no Content-Length once it passes the limit', async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(32));
      },
    });
    const url = 'https://registry.example.test/huge.json';
    expect(await codeOf(fetchCrsRegistry(async () => new Response(endless), url))).toBe(
      'crsPluginFetchFailed',
    );
    // Cut off just past the 2 MiB limit, not read to the end.
    expect(sent).toBeLessThan(3 * 1024 * 1024);
  });
});
