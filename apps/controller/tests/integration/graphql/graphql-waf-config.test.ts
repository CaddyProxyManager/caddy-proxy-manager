/**
 * WAF presets, CRS plugins and the Caddy module selection over GraphQL: every write is read back
 * from the database, the registry is a fake GitHub, and every field refuses a non-admin.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import * as db from '../../../src/lib/db/schema';
import { getSetting } from '../../../src/lib/settings';
import { type CaddyValidator, setCaddyValidator } from '../../../src/lib/waf/dry-run';
import { installFakeCaddy } from '../../helpers/caddy-admin';
import { FAKE_BOT, WORDPRESS, fakeGithub } from '../../helpers/fake-github';

const NOW = '2026-03-01T00:00:00.000Z';
const RULE = 'SecRule ARGS "@rx x" "id:9700,phase:1,pass,nolog,ctl:ruleRemoveById=942100"';
const WORDPRESS_REPO = 'coreruleset/wordpress-rule-exclusions-plugin';
const FAKE_BOT_REPO = 'coreruleset/fake-bot-plugin';
const CONFIG =
  'SecAction "id:9507010,phase:1,pass,nolog,setvar:tx.wordpress-rule-exclusions-plugin_enabled=0"';

function contextFor(role: string): GraphQLContext {
  return {
    viewer: async () => ({ userId: 1, role, authMethod: 'bearer' as const }),
    access: async () => ({
      userId: 1,
      role,
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(document: string, role = 'admin', variableValues?: Record<string, unknown>) {
  return graphql({ schema, source: document, contextValue: contextFor(role), variableValues });
}

async function ok<T = Record<string, unknown>>(document: string, vars?: Record<string, unknown>) {
  const result = await run(document, 'admin', vars);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

let restore: CaddyValidator | null = null;
const realFetch = globalThis.fetch;

/** The model reaches GitHub through the global fetch when no fetcher is handed in. */
function useGithub(repos: Parameters<typeof fakeGithub>[0]) {
  const github = fakeGithub(repos);
  globalThis.fetch = github.fetcher as unknown as typeof fetch;
  return github;
}

beforeEach(async () => {
  // One schema for the file: a connection per test would crowd a shared server.
  for (const table of [db.wafPresets, db.crsPlugins, db.proxyHosts, db.settings, db.users]) {
    await ctx.db.delete(table);
  }
  installFakeCaddy();
  // No agent can validate here: the save proceeds, as it does on a stack without one.
  restore = setCaddyValidator(async () => null);
  // Every public registry entry has a repository, or the check pass stops short on the missing one.
  useGithub({ [WORDPRESS_REPO]: WORDPRESS, [FAKE_BOT_REPO]: FAKE_BOT });
  await ctx.db.insert(db.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    subject: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

afterEach(() => {
  if (restore) setCaddyValidator(restore);
  restore = null;
  globalThis.fetch = realFetch;
});

describe('the admin gate', () => {
  const documents = [
    '{ wafPresets { id } }',
    '{ crsPlugins { id } }',
    '{ crsPluginRegistry { settings { refreshIntervalHours } } }',
    'mutation { createWafPreset(input: {}) { id } }',
    'mutation { updateWafPreset(id: 1, input: {}) { id } }',
    'mutation { deleteWafPreset(id: 1) }',
    'mutation { createCrsPlugin(input: {}) { id } }',
    'mutation { updateCrsPlugin(id: 1, input: {}) { id } }',
    'mutation { deleteCrsPlugin(id: 1) }',
    'mutation { updateCrsPluginFromRegistry(id: 1) { id } }',
    'mutation { checkCrsPluginRegistry { checkedAt } }',
    'mutation { setCrsPluginRegistrySettings(input: {}) { hasGithubToken } }',
    'mutation { setCaddyModules(input: {}) }',
  ];

  it('refuses every field to an operator, and writes nothing', async () => {
    for (const document of documents) {
      const result = await run(document, 'operator');
      expect(result.errors?.[0]?.message, document).toContain(
        "This account's role does not allow this request",
      );
    }
    expect(await ctx.db.select().from(db.wafPresets)).toEqual([]);
    expect(await ctx.db.select().from(db.crsPlugins)).toEqual([]);
    expect(await getSetting('caddy_build')).toBeNull();
  });
});

describe('WAF presets', () => {
  it('creates, lists, updates and deletes one', async () => {
    const created = await ok<{ createWafPreset: { id: number; name: string } }>(
      'mutation ($input: JSON!) { createWafPreset(input: $input) { id name description } }',
      { input: { name: ' Nextcloud ', description: 'uploads', directives: `\n${RULE}\n` } },
    );
    const id = created.createWafPreset.id;
    expect(created.createWafPreset).toMatchObject({ name: 'Nextcloud', description: 'uploads' });

    const listed = await ok<{ wafPresets: { name: string; directives: string }[] }>(
      '{ wafPresets { name directives } }',
    );
    expect(listed.wafPresets).toEqual([{ name: 'Nextcloud', directives: RULE }]);

    const updated = await ok<{ updateWafPreset: { description: string | null } }>(
      'mutation ($id: Int!) { updateWafPreset(id: $id, input: { description: null }) { description } }',
      { id },
    );
    expect(updated.updateWafPreset.description).toBeNull();
    const [row] = await ctx.db.select().from(db.wafPresets).where(eq(db.wafPresets.id, id));
    expect(row).toMatchObject({ name: 'Nextcloud', description: null, directives: RULE });

    await ok('mutation ($id: Int!) { deleteWafPreset(id: $id) }', { id });
    expect(await ctx.db.select().from(db.wafPresets)).toEqual([]);
  });

  it('refuses a body without name and directives, or with a non-string field, as REST does', async () => {
    const missing = await run('mutation { createWafPreset(input: { name: "x" }) { id } }');
    expect(missing.errors?.[0]?.message).toBe('name and directives are required');
    const wrong = await run('mutation { updateWafPreset(id: 1, input: { name: 3 }) { id } }');
    expect(wrong.errors?.[0]?.message).toBe('name must be a string');
    expect(await ctx.db.select().from(db.wafPresets)).toEqual([]);
  });

  it("surfaces the model's refusal for a preset that does not exist", async () => {
    const result = await run('mutation { deleteWafPreset(id: 99999) }');
    expect(result.errors?.[0]?.message).toBe('WAF preset not found');
  });
});

describe('CRS plugins', () => {
  async function install() {
    const data = await ok<{ createCrsPlugin: { id: number; version: string } }>(
      'mutation { createCrsPlugin(input: { name: "wordpress-rule-exclusions" }) { id version fileNames } }',
    );
    return data.createCrsPlugin;
  }

  it('installs from the one registry listing the name, edits the config and uninstalls', async () => {
    const plugin = await install();
    expect(plugin.version).toBe('v1.2.0');
    const [stored] = await ctx.db.select().from(db.crsPlugins);
    expect(stored).toMatchObject({
      name: 'wordpress-rule-exclusions',
      repository: `https://github.com/${WORDPRESS_REPO}`,
      version: 'v1.2.0',
      configOverride: null,
    });

    const listed = await ok<{
      crsPlugins: { id: number }[];
      crsPluginRegistry: { plugins: { name: string; installedId: number | null }[] };
    }>('{ crsPlugins { id } crsPluginRegistry { plugins { name installedId } } }');
    expect(listed.crsPlugins).toEqual([{ id: plugin.id }]);
    expect(listed.crsPluginRegistry.plugins).toContainEqual({
      name: 'wordpress-rule-exclusions',
      installedId: plugin.id,
    });

    const configured = await ok<{ updateCrsPlugin: { configOverride: string | null } }>(
      'mutation ($id: Int!, $input: JSON!) { updateCrsPlugin(id: $id, input: $input) { configOverride } }',
      { id: plugin.id, input: { config: CONFIG } },
    );
    expect(configured.updateCrsPlugin.configOverride).toBe(CONFIG);
    const [edited] = await ctx.db.select().from(db.crsPlugins);
    expect(edited.configOverride).toBe(CONFIG);

    const reset = await ok<{ updateCrsPlugin: { configOverride: string | null } }>(
      'mutation ($id: Int!) { updateCrsPlugin(id: $id, input: { config: null }) { configOverride } }',
      { id: plugin.id },
    );
    expect(reset.updateCrsPlugin.configOverride).toBeNull();

    await ok('mutation ($id: Int!) { deleteCrsPlugin(id: $id) }', { id: plugin.id });
    expect(await ctx.db.select().from(db.crsPlugins)).toEqual([]);
  });

  it('updates an installed plugin to the release GitHub now lists', async () => {
    const plugin = await install();
    useGithub({ [WORDPRESS_REPO]: { ...WORDPRESS, release: 'v1.3.0' } });

    const data = await ok<{ updateCrsPluginFromRegistry: { version: string } }>(
      'mutation ($id: Int!) { updateCrsPluginFromRegistry(id: $id) { version fileNames } }',
      { id: plugin.id },
    );
    expect(data.updateCrsPluginFromRegistry.version).toBe('v1.3.0');
    const [row] = await ctx.db.select().from(db.crsPlugins);
    expect(row.version).toBe('v1.3.0');
  });

  it('refuses a config that is neither a string nor null, and a body without a name', async () => {
    const plugin = await install();
    const config = await run(
      'mutation ($id: Int!) { updateCrsPlugin(id: $id, input: { config: 1 }) { id } }',
      'admin',
      { id: plugin.id },
    );
    expect(config.errors?.[0]?.message).toBe('config must be a string or null');
    const name = await run('mutation { createCrsPlugin(input: { name: "  " }) { id } }');
    expect(name.errors?.[0]?.message).toBe('name is required');
  });

  it("surfaces the model's refusal for a plugin that does not exist", async () => {
    const result = await run('mutation { deleteCrsPlugin(id: 99999) }');
    expect(result.errors?.[0]?.message).toBe('CRS plugin not found');
  });
});

describe('the CRS plugin registry', () => {
  it('saves the settings and reads them back without the token', async () => {
    const saved = await ok<{
      setCrsPluginRegistrySettings: { refreshIntervalHours: number; hasGithubToken: boolean };
    }>(
      'mutation { setCrsPluginRegistrySettings(input: { refreshIntervalHours: 12 }) { refreshIntervalHours hasGithubToken } }',
    );
    expect(saved.setCrsPluginRegistrySettings).toEqual({
      refreshIntervalHours: 12,
      hasGithubToken: false,
    });

    const read = await ok<{
      crsPluginRegistry: { settings: { refreshIntervalHours: number; registries: unknown[] } };
    }>('{ crsPluginRegistry { settings { refreshIntervalHours registries { id name url } } } }');
    expect(read.crsPluginRegistry.settings.refreshIntervalHours).toBe(12);
    expect(read.crsPluginRegistry.settings.registries).toHaveLength(1);
    // The schema has no field for it.
    const token = await run('{ crsPluginRegistry { settings { githubToken } } }');
    expect(token.errors?.[0]?.message).toContain('githubToken');
  });

  it('refuses a malformed body as REST does', async () => {
    for (const [document, message] of [
      [
        'mutation { setCrsPluginRegistrySettings(input: { refreshIntervalHours: "12" }) { hasGithubToken } }',
        'refreshIntervalHours must be a number',
      ],
      [
        'mutation { setCrsPluginRegistrySettings(input: { registries: [{ name: "x" }] }) { hasGithubToken } }',
        'registries must be a list of { id?, name, url }',
      ],
    ]) {
      expect((await run(document)).errors?.[0]?.message, document).toBe(message);
    }
  });

  it('checks every registry now and answers the pass', async () => {
    const data = await ok<{
      checkCrsPluginRegistry: {
        checkedAt: string | null;
        error: string | null;
        sources: Record<string, { fetchedAt: string | null }>;
        plugins: { name: string }[];
      };
    }>('mutation { checkCrsPluginRegistry { checkedAt error sources plugins { name } } }');
    const check = data.checkCrsPluginRegistry;
    expect(check.checkedAt).not.toBeNull();
    expect(check.error).toBeNull();
    expect(check.sources.official?.fetchedAt).not.toBeNull();
    expect(check.plugins.map((plugin) => plugin.name)).toContain('wordpress-rule-exclusions');
  });
});

describe('Caddy modules', () => {
  it('stores the selection and answers it with the diff', async () => {
    const data = await ok<{
      setCaddyModules: { selection: { modules: Record<string, boolean> }; diff: unknown };
    }>('mutation ($input: JSON!) { setCaddyModules(input: $input) }', {
      input: { modules: { 'caddy-tailscale': false, 'not-a-module': true } },
    });
    // Unknown ids are dropped, as PUT /api/v1/caddy/modules drops them.
    expect(data.setCaddyModules.selection.modules).toEqual({ 'caddy-tailscale': false });
    expect(data.setCaddyModules.diff).toBeDefined();
    expect(await getSetting<unknown>('caddy_build')).toEqual({
      modules: { 'caddy-tailscale': false },
      customModules: [],
    });
  });
});
