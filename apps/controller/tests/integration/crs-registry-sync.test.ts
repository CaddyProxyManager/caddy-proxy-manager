/**
 * Integration: the CRS plugin registry settings, the scheduled check (src/lib/crs-plugins/sync.ts)
 * and what the model does with several registries - against a real database and a fake GitHub.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../helpers/db';
import { users } from '../../src/lib/db/schema';
import { DomainError } from '../../src/lib/domain-error';
import {
  FAKE_BOT,
  type FakeRepo,
  OFFICIAL_URL,
  REGISTRY,
  WORDPRESS,
  fakeGithub,
} from '../helpers/fake-github';

let db: TestDb;
const settingsStore = new Map<string, unknown>();

vi.mock('../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => {}) }));
vi.mock('../../src/lib/settings', () => ({
  getWafSettings: async () => null,
  getDashboardSettings: async () => ({ options: { meta: null } }),
  getSetting: async (key: string) => structuredClone(settingsStore.get(key) ?? null),
  setSetting: async (key: string, value: unknown) => {
    settingsStore.set(key, structuredClone(value));
  },
}));

import {
  crsRegistryGithubToken,
  getCrsRegistrySettings,
  saveCrsRegistrySettings,
} from '../../src/lib/crs-plugins/settings';
import { getCrsRegistryState, runCrsRegistrySync } from '../../src/lib/crs-plugins/sync';
import {
  installCrsPlugin,
  listCrsRegistry,
  storedCrsPluginUpdates,
  updateCrsPlugin,
} from '../../src/lib/models/crs-plugins';

const WORDPRESS_REPO = 'coreruleset/wordpress-rule-exclusions-plugin';
const FAKE_BOT_REPO = 'coreruleset/fake-bot-plugin';
const MINE = 'https://registry.example.test/registry.json';

let userId: number;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return undefined;
}

/** Contents listings fetched: one per release a pass actually checked. */
function checked(github: ReturnType<typeof fakeGithub>): number {
  return github.requested.filter((url) => url.includes('/contents/plugins')).length;
}

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  settingsStore.clear();
  const now = new Date().toISOString();
  const [user] = await db
    .insert(users)
    .values({
      email: 'admin@test',
      name: 'Admin',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  userId = user.id;
});

describe('registry settings', () => {
  it('starts with the official registry and keeps the token encrypted', async () => {
    expect((await getCrsRegistrySettings()).registries.map((r) => r.id)).toEqual(['official']);

    await saveCrsRegistrySettings({ githubToken: ' ghp_example ' });
    const stored = JSON.stringify(settingsStore.get('crs_plugin_registry'));
    expect(stored).not.toContain('ghp_example');
    expect((await getCrsRegistrySettings()).hasGithubToken).toBe(true);
    expect(await crsRegistryGithubToken()).toBe('ghp_example');

    await saveCrsRegistrySettings({ githubToken: '' });
    expect(await crsRegistryGithubToken()).toBeNull();
  });

  it('refuses a registry that is not https, and two with one URL', async () => {
    expect(
      await codeOf(
        saveCrsRegistrySettings({ registries: [{ name: 'Local', url: 'http://10.0.0.1/r.json' }] }),
      ),
    ).toBe('crsRegistryUrlInvalid');
    expect(
      await codeOf(
        saveCrsRegistrySettings({
          registries: [
            { name: 'A', url: MINE },
            { name: 'B', url: MINE },
          ],
        }),
      ),
    ).toBe('crsRegistryDuplicate');
  });

  it('keeps an existing id and assigns new ones itself', async () => {
    await saveCrsRegistrySettings({
      registries: [
        { id: 'official', name: 'OWASP', url: OFFICIAL_URL },
        { id: 'made-up', name: 'Mine', url: MINE },
      ],
    });
    const [official, mine] = (await getCrsRegistrySettings()).registries;
    expect(official).toEqual({ id: 'official', name: 'OWASP', url: OFFICIAL_URL });
    expect(mine.id).not.toBe('made-up');
  });
});

describe('runCrsRegistrySync', () => {
  it('stores a verdict per plugin, and only checks a release once', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS, [FAKE_BOT_REPO]: FAKE_BOT });
    const state = await runCrsRegistrySync({ fetcher: github.fetcher });
    expect(state.error).toBeNull();
    expect(state.checkedAt).not.toBeNull();
    expect(state.verdicts['official/wordpress-rule-exclusions']).toMatchObject({
      supported: true,
      version: 'v1.2.0',
    });
    expect(state.verdicts['official/fake-bot']).toMatchObject({
      supported: false,
      reason: 'files',
    });
    expect(checked(github)).toBe(2);

    const listing = await listCrsRegistry(github.fetcher);
    expect(listing.find((entry) => entry.name === 'fake-bot')?.unsupported).toBe('files');
    expect(
      listing.find((entry) => entry.name === 'wordpress-rule-exclusions')?.unsupported,
    ).toBeNull();

    // Unchanged releases: the second pass resolves versions but fetches nothing to check.
    await runCrsRegistrySync({ fetcher: github.fetcher });
    expect(checked(github)).toBe(2);
  });

  it('keeps what it finished when the rate limit cuts it short, and resumes', async () => {
    const github = fakeGithub({ [WORDPRESS_REPO]: WORDPRESS, [FAKE_BOT_REPO]: FAKE_BOT });
    // fake-bot sorts first: its version lookup and listing, then out of calls on wordpress.
    github.status.apiCallsLeft = 2;
    const cut = await runCrsRegistrySync({ fetcher: github.fetcher });
    expect(cut.error?.code?.code).toBe('crsPluginRateLimited');
    expect(cut.checkedAt).toBeNull();
    expect(Object.keys((await getCrsRegistryState()).verdicts)).toEqual(['official/fake-bot']);

    github.status.apiCallsLeft = Number.POSITIVE_INFINITY;
    const resumed = await runCrsRegistrySync({ fetcher: github.fetcher });
    expect(resumed.error).toBeNull();
    expect(Object.keys(resumed.verdicts).sort()).toEqual([
      'official/fake-bot',
      'official/wordpress-rule-exclusions',
    ]);
  });

  it('records the latest release of installed plugins for their update badge', async () => {
    const repo: FakeRepo = { ...WORDPRESS };
    const github = fakeGithub({ [WORDPRESS_REPO]: repo, [FAKE_BOT_REPO]: FAKE_BOT });
    const plugin = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    repo.release = 'v1.3.0';
    await runCrsRegistrySync({ fetcher: github.fetcher });
    expect(await storedCrsPluginUpdates()).toEqual(new Map([[plugin.id, 'v1.3.0']]));
  });
});

describe('several registries', () => {
  const OTHER_WORDPRESS = 'someone/wordpress-rule-exclusions-plugin';

  async function twoRegistries() {
    await saveCrsRegistrySettings({
      registries: [
        { id: 'official', name: 'OWASP CRS', url: OFFICIAL_URL },
        { name: 'Mine', url: MINE },
      ],
    });
    return fakeGithub(
      { [WORDPRESS_REPO]: WORDPRESS, [OTHER_WORDPRESS]: WORDPRESS, [FAKE_BOT_REPO]: FAKE_BOT },
      {
        [OFFICIAL_URL]: REGISTRY,
        [MINE]: {
          plugins: [
            {
              ...REGISTRY.plugins[0],
              repository: `https://github.com/${OTHER_WORDPRESS}`,
            },
          ],
        },
      },
    );
  }

  it("lists every registry's plugins, each with the registry it came from", async () => {
    const github = await twoRegistries();
    const listing = await listCrsRegistry(github.fetcher);
    expect(
      listing
        .filter((entry) => entry.name === 'wordpress-rule-exclusions')
        .map((entry) => [entry.registryName, entry.repository]),
    ).toEqual([
      ['OWASP CRS', `https://github.com/${WORDPRESS_REPO}`],
      ['Mine', `https://github.com/${OTHER_WORDPRESS}`],
    ]);
  });

  it('installs from the registry named, and marks only that entry installed', async () => {
    const github = await twoRegistries();
    const mine = (await getCrsRegistrySettings()).registries[1].id;
    const plugin = await installCrsPlugin(
      mine,
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    expect(plugin.repository).toBe(`https://github.com/${OTHER_WORDPRESS}`);

    const listing = await listCrsRegistry(github.fetcher);
    expect(listing.find((entry) => entry.registryId === mine)?.installedId).toBe(plugin.id);
    expect(
      listing.find((entry) => entry.registryId === 'official' && entry.name === plugin.name)
        ?.installedId,
    ).toBeNull();
  });

  it('refuses an install whose rule ids overlap an installed plugin', async () => {
    await saveCrsRegistrySettings({ registries: [{ name: 'Mine', url: MINE }] });
    const github = fakeGithub(
      { [WORDPRESS_REPO]: WORDPRESS, [OTHER_WORDPRESS]: WORDPRESS },
      {
        [MINE]: {
          plugins: [
            REGISTRY.plugins[0],
            {
              ...REGISTRY.plugins[0],
              name: 'another',
              repository: `https://github.com/${OTHER_WORDPRESS}`,
              rule_id_range: { start: 9507500, end: 9508499 },
            },
          ],
        },
      },
    );
    const mine = (await getCrsRegistrySettings()).registries[0].id;
    await installCrsPlugin(mine, 'wordpress-rule-exclusions', userId, github.fetcher);
    expect(await codeOf(installCrsPlugin(mine, 'another', userId, github.fetcher))).toBe(
      'crsPluginRangeOverlaps',
    );
  });

  it('still updates a plugin whose registry was removed, from what it was installed with', async () => {
    const repo: FakeRepo = { ...WORDPRESS };
    const github = fakeGithub({ [WORDPRESS_REPO]: repo });
    const plugin = await installCrsPlugin(
      'official',
      'wordpress-rule-exclusions',
      userId,
      github.fetcher,
    );
    await saveCrsRegistrySettings({ registries: [] });
    repo.release = 'v1.3.0';
    const updated = await updateCrsPlugin(plugin.id, userId, github.fetcher);
    expect(updated.version).toBe('v1.3.0');
    expect(updated.ruleIdStart).toBe(9507000);
  });
});
