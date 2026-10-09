/**
 * Integration: src/lib/models/waf-exclusions.ts against a real database - validation, the Coraza
 * dry run, the rollback when Caddy refuses, the audit trail, and the move of the old rule-id lists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';
import { proxyHosts, users, wafExclusions } from '../../../src/lib/db/schema';
import { logAuditEvent } from '../../../src/lib/audit';
import { CaddyApplyError } from '../../../src/lib/caddy/apply-error';
import type { DomainError } from '../../../src/lib/errors/domain-error';
import { type CaddyValidator, setCaddyValidator } from '../../../src/lib/waf/dry-run';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
const applyCaddyConfig = vi.fn(async () => {});
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig }));

import {
  createWafExclusion,
  deleteWafExclusion,
  listWafExclusionRules,
  listWafExclusions,
  migrateLegacyWafSuppressions,
  updateWafExclusion,
} from '../../../src/lib/models/waf-exclusions';
import { getWafSettings, setSetting } from '../../../src/lib/settings';

let userId: number;
let hostId: number;
let restoreValidator: CaddyValidator | null = null;
const validated: string[] = [];

function validator(answer: { status: number; text: string } | null) {
  restoreValidator = setCaddyValidator(async (config) => {
    validated.push(config);
    return answer;
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as DomainError).code ?? String(error);
  }
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  vi.clearAllMocks();
  applyCaddyConfig.mockImplementation(async () => {});
  validated.length = 0;
  const now = new Date().toISOString();
  const [user] = await ctx.db
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
  const [host] = await ctx.db
    .insert(proxyHosts)
    .values({
      name: 'App',
      domains: JSON.stringify(['app.test']),
      upstreams: JSON.stringify(['app:80']),
      meta: JSON.stringify({ waf: { enabled: true, waf_mode: 'merge', load_owasp_crs: true } }),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  hostId = host.id;
  await setSetting('waf', {
    enabled: true,
    mode: 'On',
    load_owasp_crs: true,
    custom_directives: '',
  });
  validator({ status: 200, text: 'Valid configuration' });
});

afterEach(() => {
  if (restoreValidator) setCaddyValidator(restoreValidator);
  restoreValidator = null;
});

describe('createWafExclusion', () => {
  it('stores the normalised exclusion, applies it and audits it', async () => {
    const created = await createWafExclusion(
      {
        ruleId: '942100',
        proxyHostId: hostId,
        path: '/api//upload/../files/*',
        target: 'args:content',
        reason: ' Rich text editor ',
      },
      userId,
    );
    expect(created).toMatchObject({
      ruleId: 942100,
      proxyHostId: hostId,
      hostName: 'App',
      path: '/api/files/*',
      target: 'ARGS:content',
      reason: 'Rich text editor',
      createdBy: 'Admin',
    });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    // Coraza saw the new rule before it was stored.
    expect(validated.some((config) => config.includes('ruleRemoveTargetById=942100'))).toBe(true);
    // The preload mocks the audit module; the call is what this checks.
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'waf_exclusion',
        action: 'create',
        summary: 'Added an exclusion for WAF rule 942100',
      }),
    );
  });

  it('refuses a protected rule, a duplicate and an unknown host', async () => {
    expect(await codeOf(createWafExclusion({ ruleId: 949110 }, userId))).toBe(
      'wafExclusionRuleProtected',
    );
    await createWafExclusion({ ruleId: 942100 }, userId);
    expect(await codeOf(createWafExclusion({ ruleId: 942100 }, userId))).toBe(
      'wafExclusionDuplicate',
    );
    expect(await codeOf(createWafExclusion({ ruleId: 942100, proxyHostId: 9999 }, userId))).toBe(
      'wafExclusionHostNotFound',
    );
  });

  it('stores nothing when Coraza refuses the result', async () => {
    validator({
      status: 422,
      text: 'Error: provision http.handlers.waf: invalid WAF config: server candidate_0 bad',
    });
    expect(await codeOf(createWafExclusion({ ruleId: 942100 }, userId))).toBe(
      'wafDryRunRejectedGlobal',
    );
    expect(await listWafExclusionRules()).toEqual([]);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('rolls back and re-applies when Caddy refuses the config', async () => {
    applyCaddyConfig.mockImplementationOnce(async () => {
      throw new CaddyApplyError('refused', 'CADDY_REJECTED');
    });
    expect(await codeOf(createWafExclusion({ ruleId: 942100 }, userId))).toBe(
      'wafExclusionRejected',
    );
    expect(await listWafExclusionRules()).toEqual([]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps the exclusion when Caddy is only unreachable', async () => {
    applyCaddyConfig.mockImplementationOnce(async () => {
      throw new CaddyApplyError('down', 'CADDY_UNREACHABLE');
    });
    await createWafExclusion({ ruleId: 942100 }, userId);
    expect(await listWafExclusionRules()).toHaveLength(1);
  });
});

describe('updateWafExclusion and deleteWafExclusion', () => {
  it('changes the scope, and restores it when Caddy refuses', async () => {
    const created = await createWafExclusion({ ruleId: 942100 }, userId);
    await updateWafExclusion(created.id, { ruleId: 942100, path: '/upload' }, userId);
    expect((await listWafExclusions())[0]?.path).toBe('/upload');

    applyCaddyConfig.mockImplementationOnce(async () => {
      throw new CaddyApplyError('refused', 'CADDY_REJECTED');
    });
    expect(
      await codeOf(updateWafExclusion(created.id, { ruleId: 942100, path: '/other' }, userId)),
    ).toBe('wafExclusionRejected');
    expect((await listWafExclusions())[0]?.path).toBe('/upload');
  });

  it('removes one, and puts it back when Caddy refuses', async () => {
    const created = await createWafExclusion({ ruleId: 942100 }, userId);
    applyCaddyConfig.mockImplementationOnce(async () => {
      throw new CaddyApplyError('refused', 'CADDY_REJECTED');
    });
    expect(await codeOf(deleteWafExclusion(created.id, userId))).toBe('wafExclusionRejected');
    expect(await listWafExclusionRules()).toHaveLength(1);

    await deleteWafExclusion(created.id, userId);
    expect(await listWafExclusionRules()).toEqual([]);
    expect(await codeOf(deleteWafExclusion(created.id, userId))).toBe('wafExclusionNotFound');
  });

  it('goes with its host', async () => {
    await createWafExclusion({ ruleId: 942100, proxyHostId: hostId }, userId);
    await ctx.db.delete(proxyHosts);
    expect(await ctx.db.select().from(wafExclusions)).toEqual([]);
  });
});

describe('migrateLegacyWafSuppressions', () => {
  it('moves the global and per-host lists into exclusions and empties them', async () => {
    await setSetting('waf', {
      enabled: true,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: '',
      excluded_rule_ids: [942100, 920350],
    });
    await ctx.db.update(proxyHosts).set({
      meta: JSON.stringify({
        waf: { enabled: true, waf_mode: 'override', excluded_rule_ids: [941100] },
        rate_limit: { enabled: false },
      }),
    });

    expect(await migrateLegacyWafSuppressions()).toBe(3);

    const rules = await listWafExclusionRules();
    expect(
      rules.map(({ ruleId, proxyHostId, path, target }) => ({ ruleId, proxyHostId, path, target })),
    ).toEqual([
      { ruleId: 942100, proxyHostId: null, path: null, target: null },
      { ruleId: 920350, proxyHostId: null, path: null, target: null },
      { ruleId: 941100, proxyHostId: hostId, path: null, target: null },
    ]);
    expect((await getWafSettings())?.excluded_rule_ids).toBeUndefined();
    const [host] = await ctx.db.select().from(proxyHosts);
    const meta = JSON.parse(host?.meta ?? '{}');
    expect(meta.waf.excluded_rule_ids).toBeUndefined();
    expect(meta.waf.waf_mode).toBe('override');
    expect(meta.rate_limit).toEqual({ enabled: false });
    // Moved, not created by anyone: no Coraza run and no reload are needed for the same config.
    expect(validated).toEqual([]);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    await setSetting('waf', {
      enabled: true,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: '',
      excluded_rule_ids: [942100],
    });
    expect(await migrateLegacyWafSuppressions()).toBe(1);
    expect(await migrateLegacyWafSuppressions()).toBe(0);
    expect(await listWafExclusionRules()).toHaveLength(1);
  });

  it('stores a dashboard exclusion as a flag, not a host', async () => {
    validator({ status: 200, text: '' });
    const created = await createWafExclusion({ ruleId: 942100, proxyHostId: -1 }, userId);
    expect(created.proxyHostId).toBe(-1);
    expect(created.hostName).toBeNull();
    const [row] = await ctx.db.select().from(wafExclusions);
    expect(row.proxyHostId).toBeNull();
    expect(row.dashboard).toBe(true);
    expect((await listWafExclusionRules()).map((rule) => rule.proxyHostId)).toEqual([-1]);

    const moved = await updateWafExclusion(
      created.id,
      { ruleId: 942100, proxyHostId: hostId },
      userId,
    );
    expect(moved.proxyHostId).toBe(hostId);
    const [after] = await ctx.db.select().from(wafExclusions);
    expect(after.dashboard).toBe(false);
  });

  it('lists the built-in dashboard exclusion ahead of the stored ones', async () => {
    const { listWafExclusionsWithBuiltIn } = await import('../../../src/lib/models/waf-exclusions');
    const rows = await listWafExclusionsWithBuiltIn();
    expect(rows[0]).toMatchObject({ ruleId: 920420, proxyHostId: -1, mandatory: true });
    expect((await listWafExclusions()).length).toBe(0);
  });
});
