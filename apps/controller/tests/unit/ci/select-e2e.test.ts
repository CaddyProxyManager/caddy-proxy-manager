/**
 * The e2e selector's map against the specs on disk: a renamed spec would otherwise drop out of
 * every PR run silently, and only main's full run would still reach it.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from '@/messages/en.json';
import {
  changedNamespaces,
  MESSAGES,
  NAMESPACES,
  playwrightFilters,
  RULES,
  selectSpecs,
} from '@/scripts/select-e2e';

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '../../e2e');
const SPECS = readdirSync(E2E, { recursive: true, encoding: 'utf8' })
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => f.endsWith('.spec.ts'));
const PREFIXES = [
  ...new Set([
    ...RULES.flatMap((r) => r.specs),
    ...Object.values(NAMESPACES).flat(),
    'accessibility',
  ]),
];
// Read by every screen, so a change to one runs the whole suite.
const SHARED_NAMESPACES = ['common', 'errors', 'nav', 'passwordPolicy', 'ui'];

function picked(...files: string[]): string[] {
  const selection = selectSpecs(files);
  if (selection.mode !== 'some') throw new Error(`expected some, got ${selection.mode}`);
  return selection.specs;
}

describe('select-e2e map', () => {
  it.each(PREFIXES)('%s names at least one spec', (prefix) => {
    expect(SPECS.some((spec) => spec.startsWith(prefix))).toBe(true);
  });

  it.each(SPECS)('%s is reachable from some source rule', (spec) => {
    expect(PREFIXES.some((prefix) => spec.startsWith(prefix))).toBe(true);
  });

  it('decides every catalog namespace', () => {
    const undecided = Object.keys(catalog).filter(
      (n) => !NAMESPACES[n] && !SHARED_NAMESPACES.includes(n),
    );
    expect(undecided).toEqual([]);
  });
});

describe('the message catalog', () => {
  it('finds the namespaces a change touched', () => {
    const before = JSON.stringify({ ui: { a: 'A' }, waf: { b: 'B' }, gone: {} });
    const after = JSON.stringify({ ui: { a: 'A' }, waf: { b: 'C' }, fresh: {} });
    expect(changedNamespaces(before, after).sort()).toEqual(['fresh', 'gone', 'waf']);
  });

  it('narrows to the changed namespaces', () => {
    const selection = selectSpecs([MESSAGES], ['waf', 'auditLog']);
    expect(selection.mode === 'some' && selection.specs).toEqual([
      'accessibility',
      'audit-log',
      'functional/waf-',
      'proxy-hosts/waf',
    ]);
  });

  it('runs everything for a shared namespace, or when the diff is unknown', () => {
    expect(selectSpecs([MESSAGES], ['waf', 'ui']).mode).toBe('all');
    expect(selectSpecs([MESSAGES]).mode).toBe('all');
  });
});

describe('selectSpecs', () => {
  it('skips the suite for docs, the site and unit tests', () => {
    expect(
      selectSpecs([
        'README.md',
        'apps/site/src/content/docs/index.mdx',
        'apps/controller/tests/unit/waf/waf.test.ts',
        '.github/workflows/test.yml',
      ]).mode,
    ).toBe('none');
  });

  it('runs everything for shared code, its own workflow and anything unmapped', () => {
    for (const file of [
      'apps/controller/src/components/ui/DataTable.tsx',
      'apps/controller/src/lib/db/schema.pg.ts',
      'apps/controller/src/lib/agent/registry.ts',
      'apps/controller/tests/helpers/proxy-api.ts',
      '.github/workflows/e2e.yml',
      'bun.lock',
      'somewhere/new.ts',
    ])
      expect(selectSpecs([file]).mode).toBe('all');
  });

  it('one unmapped file outweighs every mapped one', () => {
    expect(
      selectSpecs(['apps/controller/src/lib/waf/seclang.ts', 'docker/web/Dockerfile']).mode,
    ).toBe('all');
  });

  it('narrows a feature change to its specs', () => {
    expect(picked('apps/controller/src/lib/waf/seclang.ts')).toEqual([
      'functional/waf-',
      'proxy-hosts/waf',
    ]);
  });

  it('prefers a file rule over its folder', () => {
    expect(picked('apps/controller/src/lib/agent/geoip.ts')).toContain('proxy-hosts/geoblock');
    expect(picked('apps/controller/src/app/(dashboard)/settings/CaptchaSection.tsx')).toEqual([
      'accessibility',
      'auth/captcha-cap',
    ]);
  });

  it('adds the accessibility crawl for anything that renders', () => {
    expect(picked('apps/controller/src/lib/l4/ports.ts')).not.toContain('accessibility');
    expect(picked('apps/controller/src/components/l4-proxy-hosts/L4HostDialogs.tsx')).toContain(
      'accessibility',
    );
  });

  it('runs a changed spec itself', () => {
    expect(picked('apps/controller/tests/e2e/users/groups.spec.ts')).toEqual([
      'users/groups.spec.ts',
    ]);
  });

  it('hands Playwright path filters', () => {
    expect(playwrightFilters(['auth/', 'dashboard'])).toEqual([
      'tests/e2e/auth/',
      'tests/e2e/dashboard',
    ]);
  });
});
