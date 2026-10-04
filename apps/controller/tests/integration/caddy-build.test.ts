/**
 * Module selection, the compose override it produces, and the gate it feeds: *desired* modules
 * (what the admin selected) vs *applied* (what the binary was built with). Generation uses the
 * intersection - Caddy rejects a whole document naming a module it lacks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

const {
  applyCaddyBuild,
  defaultModuleSpecs,
  getAppliedModuleSpecs,
  getCaddyBuildDiff,
  getCaddyBuildStatus,
  getCaddyModuleAvailability,
  getModuleGateState,
  isDnsProviderUsable,
  isFeatureUsable,
  parseModuleSpecList,
  resolveEnabledModuleIds,
  resolveModuleSpecs,
  sanitizeCaddyBuildSettings,
} = await import('../../src/lib/caddy-build');
import { CADDY_MODULES, dnsModuleId } from '../../src/lib/caddy-modules';
import { saveCaddyBuildSettings } from '../../src/lib/settings';
import { installFakeCaddy, type FakeCaddy } from '../helpers/caddy-admin';
import { startFakeAgent } from '../helpers/fake-agent';
import * as schema from '../../src/lib/db/schema';

type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;
let agent: FakeAgent;

/** Frames at test start, so the one every agent gets on attach is not counted as a rebuild. */
let pushBaseline = 0;

/** Saving the build settings does not push, only applying does, so a new frame is the request. */
function rebuildRequested(): boolean {
  return agent.requests.filter((r) => r.kind === 'desired-state').length > pushBaseline;
}

const L4 = 'github.com/mholt/caddy-l4';
const CORAZA = 'github.com/corazawaf/coraza-caddy/v2';
const BLOCKER = 'github.com/fuomag9/caddy-blocker-plugin';
const CLOUDFLARE = 'github.com/caddy-dns/cloudflare';

/** The agent's *applied* set, reported only after a build succeeds and Caddy is healthy. */
function setAppliedModules(specs: string[]) {
  agent.state.appliedModules = specs;
}

beforeEach(async () => {
  agent = await startFakeAgent();
  pushBaseline = agent.requests.filter((r) => r.kind === 'desired-state').length;
  await ctx.db.delete(schema.settings);
});

afterEach(async () => {
  await agent.stop();
});

describe('selection resolution', () => {
  it('treats an unknown module id as enabled, unless it is opt-in', async () => {
    // A module added to the catalog after the last save is on, matching the running image.
    const ids = resolveEnabledModuleIds({ modules: { 'caddy-l4': true }, customModules: [] });
    expect(ids).toEqual(CADDY_MODULES.filter((m) => m.defaultEnabled !== false).map((m) => m.id));
    expect(
      resolveEnabledModuleIds({ modules: { 'cache-handler': true }, customModules: [] }),
    ).toContain('cache-handler');
  });

  it('drops only the modules explicitly set to false', () => {
    const specs = resolveModuleSpecs({ modules: { 'caddy-l4': false }, customModules: [] });
    expect(specs).not.toContain(L4);
    expect(specs).toContain(CORAZA);
  });

  it('includes enabled custom modules with their version', () => {
    const specs = resolveModuleSpecs({
      modules: {},
      customModules: [
        { modulePath: 'github.com/o/pinned', version: 'v1.2.3', enabled: true },
        { modulePath: 'github.com/o/off', enabled: false },
      ],
    });
    expect(specs).toContain('github.com/o/pinned@v1.2.3');
    expect(specs).not.toContain('github.com/o/off');
  });

  it('silently skips a stored custom module that no longer validates', () => {
    // A hand-edited row or an older release's data must not inject a shell fragment.
    const specs = resolveModuleSpecs({
      modules: {},
      customModules: [{ modulePath: 'github.com/o/r; rm -rf /', enabled: true }],
    });
    expect(specs.join(' ')).not.toContain('rm -rf');
  });

  it('produces a stable order regardless of toggle order', () => {
    const a = resolveModuleSpecs({
      modules: { 'caddy-l4': true, 'coraza-waf': true },
      customModules: [],
    });
    const b = resolveModuleSpecs({
      modules: { 'coraza-waf': true, 'caddy-l4': true },
      customModules: [],
    });
    expect(a).toEqual(b);
  });
});

describe('applied module specs', () => {
  it('reports the full catalog when no rebuild has happened', async () => {
    // Null means the shipped image, which carries everything; an empty list would drop every
    // plugin-backed handler on a healthy install.
    expect(await getAppliedModuleSpecs()).toEqual(defaultModuleSpecs());
  });

  it('reads back exactly what the agent says it built', async () => {
    setAppliedModules([L4, CORAZA]);
    expect(await getAppliedModuleSpecs()).toEqual([CORAZA, L4].sort());
  });

  it('sorts what the agent reports, so the order it arrives in cannot move a diff', async () => {
    setAppliedModules([CORAZA, L4]);
    expect(await getAppliedModuleSpecs()).toEqual([CORAZA, L4].sort());
  });

  it('falls back to the full catalog when no agent answers at all', async () => {
    await agent.stop();
    // A missing agent is no evidence the binary lacks plugins.
    expect(await getAppliedModuleSpecs()).toEqual(defaultModuleSpecs());
  });

  it('parses a whitespace-separated build arg', () => {
    expect(parseModuleSpecList(`  ${L4}   ${CORAZA}\n`)).toEqual([CORAZA, L4].sort());
  });
});

describe('diff', () => {
  it('reports no rebuild needed for a default install', async () => {
    const diff = await getCaddyBuildDiff();
    expect(diff.needsRebuild).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('names what a rebuild would add and remove', async () => {
    setAppliedModules([L4, CORAZA]);
    await saveCaddyBuildSettings({
      modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, m.id === 'caddy-l4'])),
      customModules: [{ modulePath: 'github.com/o/new', enabled: true }],
    });

    const diff = await getCaddyBuildDiff();
    expect(diff.needsRebuild).toBe(true);
    expect(diff.added).toEqual(['github.com/o/new']);
    expect(diff.removed).toEqual([CORAZA]);
  });
});

describe('feature gating', () => {
  it('allows a feature only when it is both selected and compiled in', async () => {
    setAppliedModules([L4, BLOCKER]);
    await saveCaddyBuildSettings({
      modules: Object.fromEntries(
        CADDY_MODULES.map((m) => [m.id, m.id === 'caddy-l4' || m.id === 'coraza-waf']),
      ),
      customModules: [],
    });

    const availability = await getCaddyModuleAvailability();
    expect(isFeatureUsable(availability, 'l4')).toBe(true);
    // Not built yet - emitting it would fail the whole config.
    expect(isFeatureUsable(availability, 'waf')).toBe(false);
    expect(isFeatureUsable(availability, 'geoblock')).toBe(false);
  });

  it('treats DNS-01 per provider, not as one flag', async () => {
    setAppliedModules([CLOUDFLARE]);
    await saveCaddyBuildSettings({
      modules: Object.fromEntries(
        CADDY_MODULES.map((m) => [m.id, m.id === dnsModuleId('cloudflare')]),
      ),
      customModules: [],
    });

    const availability = await getCaddyModuleAvailability();
    expect(isDnsProviderUsable(availability, 'cloudflare')).toBe(true);
    expect(isDnsProviderUsable(availability, 'route53')).toBe(false);
    expect(isDnsProviderUsable(availability, 'not-a-provider')).toBe(false);
  });

  it('ignores the @version suffix when matching a custom module path', async () => {
    setAppliedModules([`${L4}@v0.0.1`]);
    const availability = await getCaddyModuleAvailability();
    expect(availability.appliedPaths.has(L4)).toBe(true);
  });
});

describe('module gate state for the UI', () => {
  it('gates on the selection, not on the built image', async () => {
    // Following the applied set would grey out a feature just switched on; pendingRebuild says
    // "saved, not live yet".
    setAppliedModules([L4]);
    await saveCaddyBuildSettings({ modules: {}, customModules: [] });

    const gate = await getModuleGateState();
    expect(gate.features.waf).toBe(true);
    expect(gate.pendingRebuild).toBe(true);
    expect(gate.moduleNames.waf).toBe('Coraza WAF');
    expect(gate.enabledModuleIds).toContain(dnsModuleId('cloudflare'));
  });

  it('reports a feature as off once its module is deselected', async () => {
    await saveCaddyBuildSettings({ modules: { 'coraza-waf': false }, customModules: [] });
    const gate = await getModuleGateState();
    expect(gate.features.waf).toBe(false);
    expect(gate.features.geoblock).toBe(true);
  });
});

describe('sanitizeCaddyBuildSettings', () => {
  it('drops module ids that are not in the catalog', () => {
    const result = sanitizeCaddyBuildSettings({
      modules: { 'caddy-l4': false, 'not-a-module': false },
      customModules: [],
    });
    expect(result.modules).toEqual({ 'caddy-l4': false });
  });

  it('normalizes custom module paths', () => {
    const result = sanitizeCaddyBuildSettings({
      customModules: [{ modulePath: ' https://github.com/o/r/ ', version: ' v1 ', enabled: true }],
    });
    expect(result.customModules).toEqual([
      { modulePath: 'github.com/o/r', version: 'v1', enabled: true },
    ]);
  });

  it('keeps a trimmed display name, drops a blank one, and leaves it out of the build spec', () => {
    const result = sanitizeCaddyBuildSettings({
      customModules: [
        { name: '  Security  ', modulePath: 'github.com/o/a', enabled: true },
        { name: '   ', modulePath: 'github.com/o/b', enabled: true },
      ],
    });
    expect(result.customModules).toEqual([
      { name: 'Security', modulePath: 'github.com/o/a', enabled: true },
      { modulePath: 'github.com/o/b', enabled: true },
    ]);
    expect(resolveModuleSpecs(result).filter((spec) => spec.startsWith('github.com/o/'))).toEqual([
      'github.com/o/a',
      'github.com/o/b',
    ]);
  });

  it('rejects a display name that is too long', () => {
    expect(() =>
      sanitizeCaddyBuildSettings({
        customModules: [{ name: 'x'.repeat(81), modulePath: 'github.com/o/r', enabled: true }],
      }),
    ).toThrow(/at most 80 characters/);
  });

  it('rejects an invalid custom module rather than dropping it', () => {
    // Dropping it silently would make a typo look like a successful save.
    expect(() =>
      sanitizeCaddyBuildSettings({ customModules: [{ modulePath: 'nope', enabled: true }] }),
    ).toThrow(/host and a path/);
  });

  it('rejects a duplicate custom module path', () => {
    expect(() =>
      sanitizeCaddyBuildSettings({
        customModules: [
          { modulePath: 'github.com/o/r', enabled: true },
          { modulePath: 'https://github.com/o/r', enabled: true },
        ],
      }),
    ).toThrow(/Duplicate/);
  });
});

describe('applyCaddyBuild', () => {
  it('regenerates the config before signalling the rebuild', async () => {
    // Caddy runs with --resume: a saved config naming a module the new binary lacks keeps the proxy
    // and admin API down. So the apply comes before the trigger.
    const caddy: FakeCaddy = installFakeCaddy();
    await saveCaddyBuildSettings({ modules: { 'coraza-waf': false }, customModules: [] });

    await applyCaddyBuild();

    expect(caddy.loads.length).toBeGreaterThan(0);
    expect(rebuildRequested()).toBe(true);
  });

  it('does not ask for a rebuild when the config apply fails', async () => {
    // The new binary would be guaranteed not to match the config Caddy resumes from.
    const caddy: FakeCaddy = installFakeCaddy();
    caddy.failWith(500, 'nope');
    await saveCaddyBuildSettings({ modules: {}, customModules: [] });

    await expect(applyCaddyBuild()).rejects.toThrow();
    expect(rebuildRequested()).toBe(false);
  });

  it('sends the selected module list to the agent', async () => {
    installFakeCaddy();
    await saveCaddyBuildSettings({ modules: { 'caddy-l4': false }, customModules: [] });

    const status = await applyCaddyBuild();
    // xcaddy compiles from source for minutes after the agent reconciles.
    expect(status.state).toBe('pending');

    const modules = agent.desired?.caddyModules ?? [];
    expect(modules).not.toContain(L4);
    expect(modules).toContain(CORAZA);
  });

  it('does not claim the new modules are applied until the build succeeds', async () => {
    // Treating a request as landed poisons the applied set: config would name modules the live
    // binary lacks, and Caddy rejects the document wholesale.
    setAppliedModules([L4, CORAZA]);
    await saveCaddyBuildSettings({
      modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, true])),
      customModules: [],
    });

    await applyCaddyBuild();

    // It only settles once the agent reports success.
    expect(await getAppliedModuleSpecs()).toEqual([CORAZA, L4].sort());
    expect((await getCaddyBuildDiff()).needsRebuild).toBe(true);
  });

  it('leaves the applied set untouched when a build never completes', async () => {
    // Failed compiles are routine; "asked for" as "built" would persist the wrong answer.
    setAppliedModules([L4]);
    await saveCaddyBuildSettings({
      modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, true])),
      customModules: [],
    });

    await applyCaddyBuild(); // the agent never reports success

    expect(await getAppliedModuleSpecs()).toEqual([L4]);
    expect(isFeatureUsable(await getCaddyModuleAvailability(), 'waf')).toBe(false);
  });

  it('reports the new set once the agent reports a successful build', async () => {
    installFakeCaddy();
    setAppliedModules([L4]);
    await saveCaddyBuildSettings({ modules: {}, customModules: [] });
    await applyCaddyBuild();

    // Only after build + up + healthy.
    agent.completeBuild();

    expect((await getCaddyBuildDiff()).needsRebuild).toBe(false);
    expect(isFeatureUsable(await getCaddyModuleAvailability(), 'waf')).toBe(true);
  });

  it('refuses to ask for a build with an invalid custom module', async () => {
    // Otherwise the failure surfaces minutes later as an opaque compile error.
    await saveCaddyBuildSettings({
      modules: {},
      customModules: [{ modulePath: 'github.com/o/r && evil', enabled: true }],
    });
    await expect(applyCaddyBuild()).rejects.toThrow(/Invalid module path/);
    expect(rebuildRequested()).toBe(false);
  });
});

describe('build status', () => {
  it('is idle before the agent has done anything', async () => {
    expect(await getCaddyBuildStatus()).toEqual({ state: 'idle' });
  });

  it('reports what the agent is doing', async () => {
    agent.state.buildStatus = { state: 'building', message: 'compiling' };
    expect(await getCaddyBuildStatus()).toMatchObject({ state: 'building', message: 'compiling' });
  });

  it('falls back to idle rather than throwing when no agent answers', async () => {
    await agent.stop();
    expect(await getCaddyBuildStatus()).toEqual({ state: 'idle' });
  });
});
