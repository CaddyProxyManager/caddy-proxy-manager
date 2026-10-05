/** The warning is rendered from the catalog, and its English must still read right. */
import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { createTranslator } from 'next-intl';
import messages from '../../../messages/en.json';

type Host = { name: string; enabled: boolean; customCaddyfile: string | null };
const ctx = vi.hoisted(() => ({ hosts: [] as Host[], enabled: [] as string[] }));

vi.mock('@/src/lib/caddy/image-build', () => ({
  resolveEnabledModuleIds: vi.fn().mockImplementation(() => ctx.enabled),
}));
vi.mock('@/src/lib/models/proxy-hosts', () => ({
  listProxyHosts: vi.fn().mockImplementation(async () => ctx.hosts),
}));
vi.mock('@/src/lib/models/l4-proxy-hosts', () => ({ listEnabledL4ProxyHostIds: vi.fn() }));
vi.mock('@/src/lib/models/host-agents', () => ({
  listHostAssignments: vi.fn(),
  servedByAgent: vi.fn(),
}));
vi.mock('@/src/lib/settings', () => ({
  getDnsProviderSettings: vi.fn(),
  getGeoBlockSettings: vi.fn(),
  getWafSettings: vi.fn(),
}));

import { describeCaddyfileSnippetWarning } from '@/src/lib/caddy/image-build/conflicts';
import { CADDY_MODULES } from '@/src/lib/caddy/image-build/modules';

const t = createTranslator({ locale: 'en', messages, namespace: 'settings' });

function hostsWithSnippets(count: number): Host[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `host-${index + 1}`,
    enabled: true,
    customCaddyfile: 'respond 200',
  }));
}

/** With the list style the settings action uses. */
async function render(outcome: string): Promise<string | null> {
  const warning = await describeCaddyfileSnippetWarning({ modules: {}, customModules: [] });
  if (!warning) return null;
  return t('results.caddyBuildSavedSnippetWarning', {
    outcome,
    count: warning.count,
    names: new Intl.ListFormat('en', { type: 'unit' }).format(warning.names),
    more: warning.more,
  });
}

const ADVICE =
  'which may reference a module you just switched off. Review them - a snippet Caddy can no longer adapt is skipped silently.';

describe('describeCaddyfileSnippetWarning', () => {
  it('names the first three hosts and counts the rest', async () => {
    ctx.enabled = [];
    ctx.hosts = [
      ...hostsWithSnippets(5),
      { name: 'disabled', enabled: false, customCaddyfile: 'respond 200' },
      { name: 'blank', enabled: true, customCaddyfile: '  ' },
    ];
    expect(await describeCaddyfileSnippetWarning({ modules: {}, customModules: [] })).toEqual({
      count: 5,
      names: ['host-1', 'host-2', 'host-3'],
      more: 2,
    });
  });

  it('says nothing when every module is still enabled', async () => {
    ctx.enabled = CADDY_MODULES.map((module) => module.id);
    ctx.hosts = hostsWithSnippets(2);
    expect(await describeCaddyfileSnippetWarning({ modules: {}, customModules: [] })).toBeNull();
  });

  it('says nothing when no enabled host has a snippet', async () => {
    ctx.enabled = [];
    ctx.hosts = [];
    expect(await describeCaddyfileSnippetWarning({ modules: {}, customModules: [] })).toBeNull();
  });
});

describe('settings.results.caddyBuildSavedSnippetWarning', () => {
  it('reads as the saved message followed by the old warning', async () => {
    ctx.enabled = [];
    ctx.hosts = hostsWithSnippets(5);
    expect(await render('none')).toBe(
      `Caddy module selection saved. 5 proxy hosts (host-1, host-2, host-3, and 2 more) use custom Caddyfile directives, ${ADVICE}`,
    );
  });

  it('opens with what the save set off, as the plain saved messages do', async () => {
    ctx.enabled = [];
    ctx.hosts = hostsWithSnippets(2);
    const { results } = messages.settings;
    for (const [outcome, saved] of [
      ['building', results.caddyBuildSavedBuilding],
      ['loadImage', results.caddyBuildSavedLoadImage],
      ['noAgent', results.caddyBuildSavedNoAgent],
    ]) {
      expect(await render(outcome)).toBe(
        `${saved} 2 proxy hosts (host-1, host-2) use custom Caddyfile directives, ${ADVICE}`,
      );
    }
  });

  it('agrees with a single host', async () => {
    ctx.enabled = [];
    ctx.hosts = hostsWithSnippets(1);
    expect(await render('none')).toBe(
      `${messages.settings.results.caddyBuildSaved} 1 proxy host (host-1) uses custom Caddyfile directives, ${ADVICE}`,
    );
  });
});
