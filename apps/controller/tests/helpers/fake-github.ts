/** The GitHub endpoints the CRS plugin client calls; records every URL so tests can assert on them. */
import type { Fetcher } from '../../src/lib/crs-plugins/registry';

export type FakeRepo = {
  /** A tag, or null for a repository with no releases. */
  release: string | null;
  head?: string;
  /** plugins/<name> -> contents, per ref. */
  files: Record<string, Record<string, string>>;
  descriptor?: string;
};

export const REGISTRY = {
  schema_version: 1,
  plugins: [
    {
      name: 'wordpress-rule-exclusions',
      repository: 'https://github.com/coreruleset/wordpress-rule-exclusions-plugin',
      type: 'official',
      status: 'tested',
      license: 'Apache-2.0',
      rule_id_range: { start: 9507000, end: 9507999 },
    },
    {
      name: 'fake-bot',
      repository: 'https://github.com/coreruleset/fake-bot-plugin',
      type: 'official',
      status: 'tested',
      license: 'Apache-2.0',
      rule_id_range: { start: 9504000, end: 9504999 },
    },
    {
      name: 'hidden',
      repository: 'https://github.com/coreruleset/hidden-plugin',
      type: 'official',
      status: 'draft',
      license: 'Apache-2.0',
      private: true,
      rule_id_range: { start: 9520000, end: 9520999 },
    },
  ],
};

/** The official registry's URL, which `fakeGithub` answers with `REGISTRY` unless told otherwise. */
export const OFFICIAL_URL =
  'https://raw.githubusercontent.com/coreruleset/plugin-registry/main/registry.json';

/** `registries` maps a registry URL to its document; the official one defaults to `REGISTRY`. */
export function fakeGithub(
  repos: Record<string, FakeRepo>,
  registries: Record<string, unknown> = { [OFFICIAL_URL]: REGISTRY },
) {
  const requested: string[] = [];
  const headers: Record<string, Record<string, string>> = {};
  /** Rate-limits API calls after this many succeed; Infinity never does. */
  const status = { rateLimited: false, apiCallsLeft: Number.POSITIVE_INFINITY };
  const json = (body: unknown, code = 200) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(input);
    requested.push(input);
    headers[input] = { ...(init?.headers as Record<string, string>) };
    if (status.rateLimited) return new Response('', { status: 403 });
    if (input in registries) return json(registries[input]);
    const api = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(url.pathname);
    if (url.host === 'api.github.com' && status.apiCallsLeft-- <= 0) {
      return new Response('', { status: 403 });
    }
    if (url.host === 'api.github.com' && api) {
      const repo = repos[api[1]];
      if (!repo) return json({ message: 'Not Found' }, 404);
      if (api[2] === 'releases/latest') {
        return repo.release ? json({ tag_name: repo.release }) : json({}, 404);
      }
      if (api[2] === 'commits/HEAD') return json({ sha: repo.head });
      if (api[2] === 'contents/plugins') {
        const files = repo.files[url.searchParams.get('ref') ?? ''];
        if (!files) return json({ message: 'Not Found' }, 404);
        return json(
          Object.keys(files).map((name) => ({
            name,
            type: 'file',
            download_url: `https://evil.example/${name}`,
          })),
        );
      }
    }
    const raw = /^\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (url.host === 'raw.githubusercontent.com' && raw) {
      const repo = repos[raw[1]];
      const ref = decodeURIComponent(raw[2]);
      if (raw[3] === 'plugin.yaml') {
        return repo?.descriptor ? new Response(repo.descriptor) : new Response('', { status: 404 });
      }
      const name = decodeURIComponent(raw[3].replace(/^plugins\//, ''));
      const body = repo?.files[ref]?.[name];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }
    return new Response('', { status: 404 });
  };
  return { fetcher, requested, headers, status };
}

export const WORDPRESS: FakeRepo = {
  release: 'v1.2.0',
  files: {
    'v1.2.0': {
      'wordpress-rule-exclusions-config.conf': '# enabled by default\r\n',
      'wordpress-rule-exclusions-before.conf':
        'SecRule REQUEST_FILENAME "@endsWith /wp-login.php" \\\n    "id:9507100,phase:1,pass,nolog,ctl:ruleRemoveTargetById=920273;ARGS:pwd"\n',
    },
    'v1.3.0': {
      'wordpress-rule-exclusions-config.conf': '# enabled by default\n',
      'wordpress-rule-exclusions-before.conf':
        'SecRule REQUEST_FILENAME "@endsWith /wp-login.php" "id:9507100,phase:1,pass,nolog"\n',
      'wordpress-rule-exclusions-after.conf': 'SecRuleUpdateTargetById 942100 "!ARGS:content"\n',
    },
  },
  descriptor:
    'schema_version: 1\nplugin:\n  name: "wordpress-rule-exclusions-plugin"\n  description: "CRS rule exclusions for WordPress"\n',
};

export const FAKE_BOT: FakeRepo = {
  release: 'v1.1.0',
  files: {
    'v1.1.0': {
      'fake-bot-config.conf': '',
      'fake-bot-before.conf': '',
      'fake-bot-after.conf':
        'SecRule TX:0 "@inspectFile fake-bot.lua" "id:9504120,phase:1,block"\n',
      'fake-bot.lua': 'return 1',
    },
  },
};
