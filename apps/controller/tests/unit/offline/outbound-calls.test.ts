/**
 * Every place the controller or the agent opens a connection is registered with the offline
 * switch, so a new call cannot be added without deciding what offline mode does to it. An
 * internet call asks `outboundAllowed("<id>")`; a configured or internal one carries
 * `// outbound: <id>`. Browser code is out of scope: it only ever calls this dashboard's own API.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOUND_CALL_IDS, OUTBOUND_CALLS } from '@/src/lib/offline';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SOURCES = ['apps/controller/src', 'apps/agent/src'];

/** What opens a connection, by any name this code base gives it. */
const CALL_SITES: readonly RegExp[] = [
  // A fetch whose first argument is not a same-origin path.
  /(?<![.\w])fetch\(\s*(?:[\w$]|[`'"](?!\/))/,
  /\boutboundFetch\(/,
  /\b(?:fetchImpl|fetcher|doFetch)\(/,
  /\b(?:http|https|lib)\.(?:request|get)\(/,
  /\bBun\.(?:connect|udpSocket|spawn)\(/,
  /\bnew S3Client\(/,
  /\bcreateTransport\(/,
  /\bnew Client\(/,
  /\bcreateClient\(/,
  /\bsendNotification\(/,
  // Loaded by the browser, from an address this code hands it.
  /https:\/\/[\w.]*gravatar\.com/,
];

/** The client itself: every caller of it is a call site here. */
const EXEMPT: Record<string, string> = {
  'apps/controller/src/lib/http/outbound.ts': 'the outbound client, used by the call sites',
};

const GUARD = /\boutboundAllowed\(\s*"([A-Za-z0-9]+)"\s*\)/g;
const MARKER = /\/\/ outbound: ([A-Za-z0-9]+)/g;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
const USE_CLIENT = /^\s*["']use client["']/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) yield path;
  }
}

const FILES = SOURCES.flatMap((source) =>
  [...sourceFiles(join(ROOT, source))].map((path) => ({
    file: relative(ROOT, path).split('\\').join('/'),
    text: readFileSync(path, 'utf-8'),
  })),
);

type Site = { file: string; guards: string[]; markers: string[]; lines: string[] };

const SITES: Site[] = FILES.flatMap(({ file, text }) => {
  if (USE_CLIENT.test(text) || file in EXEMPT) return [];
  const lines = text
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .filter((line) => CALL_SITES.some((pattern) => pattern.test(line)));
  if (lines.length === 0) return [];
  return [
    {
      file,
      guards: [...text.matchAll(GUARD)].map((match) => match[1]),
      markers: [...text.matchAll(MARKER)].map((match) => match[1]),
      lines,
    },
  ];
});

/** Every id a guard asks about, wherever it sits: Gravatar's is in the setting, not the URL. */
const GUARDED = new Set(FILES.flatMap(({ text }) => [...text.matchAll(GUARD)].map((m) => m[1])));
const KNOWN = new Set<string>(OUTBOUND_CALL_IDS);

describe('outbound call sites', () => {
  it('finds the ones it knows exist', () => {
    const files = SITES.map((site) => site.file);
    expect(files).toContain('apps/controller/src/lib/runtime/updates.ts');
    expect(files).toContain('apps/controller/src/lib/ldap/client.ts');
    expect(files).toContain('apps/agent/src/docker.ts');
  });

  it('are each registered, by a guard or a marker naming a known call', () => {
    const unregistered = SITES.filter(
      (site) => ![...site.guards, ...site.markers].some((id) => KNOWN.has(id)),
    ).map((site) => `${site.file}: ${site.lines[0].trim()}`);
    expect(unregistered).toEqual([]);
  });

  it('name no call that is not in the registry', () => {
    const unknown = SITES.flatMap((site) =>
      [...site.guards, ...site.markers]
        .filter((id) => !KNOWN.has(id))
        .map((id) => `${site.file}: ${id}`),
    );
    expect(unknown).toEqual([]);
  });

  it('ask the switch for every internet call, rather than only marking it', () => {
    const internet = OUTBOUND_CALL_IDS.filter((id) => OUTBOUND_CALLS[id] === 'internet');
    // The agent cannot read the controller's settings: FleetConfig.offline is its switch.
    expect(internet.filter((id) => id !== 'caddyBuild' && !GUARDED.has(id))).toEqual([]);
    const fleet = FILES.find((f) => f.file === 'apps/controller/src/lib/agent/fleet-config.ts');
    expect(fleet?.text).toContain('offlineModeEnabled()');
    const agent = FILES.find((f) => f.file === 'apps/agent/src/config.ts');
    expect(agent?.text).toContain('controllerOffline()');
  });

  it('leave no registered call without a site', () => {
    const used = new Set(SITES.flatMap((site) => [...site.guards, ...site.markers]));
    expect(OUTBOUND_CALL_IDS.filter((id) => !used.has(id))).toEqual([]);
  });
});
