/** The approval policy as stored and as checked: read leniently, refused when it names no one. */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_APPROVAL_POLICY,
  approvalPolicyProblem,
  policyCovers,
  readApprovalPolicy,
} from '../../../src/lib/approvals/policy';
import { isSubmittedForApproval } from '../../../src/lib/approvals/submitted';
import { CHANGE_KINDS, isChangeKind } from '../../../src/lib/approvals/types';
import { CHANGE_KIND_DEFINITIONS } from '../../../src/lib/approvals/kinds';

describe('readApprovalPolicy', () => {
  it('is off, with administrators approving once and tokens covered, when nothing is stored', () => {
    expect(readApprovalPolicy(null)).toEqual(DEFAULT_APPROVAL_POLICY);
    expect(DEFAULT_APPROVAL_POLICY).toMatchObject({
      enabled: false,
      approverRoles: ['admin'],
      requiredApprovals: 1,
      applyToTokens: true,
    });
  });

  it('drops what it does not know rather than failing open', () => {
    expect(
      readApprovalPolicy({
        enabled: 'yes',
        scope: 'some',
        areas: ['hosts', 'mail', 7],
        tags: [' Payments ', 'payments', ''],
        approverGroupIds: [3, '4', -1, 'x', 3],
        requiredApprovals: 3,
        applyToTokens: 0,
      }),
    ).toEqual({
      ...DEFAULT_APPROVAL_POLICY,
      areas: ['hosts'],
      tags: ['payments'],
      approverGroupIds: [3, 4],
      applyToTokens: true,
    });
    expect(readApprovalPolicy({ requiredApprovals: 2, applyToTokens: false })).toMatchObject({
      requiredApprovals: 2,
      applyToTokens: false,
    });
  });
});

describe('approvalPolicyProblem', () => {
  const on = { ...DEFAULT_APPROVAL_POLICY, enabled: true };

  it('lets anything through while off', () => {
    expect(approvalPolicyProblem({ ...DEFAULT_APPROVAL_POLICY, approverRoles: [] })).toBeNull();
  });

  it('needs approvers, and the areas or tags its scope names', () => {
    expect(approvalPolicyProblem(on)).toBeNull();
    expect(approvalPolicyProblem({ ...on, approverRoles: [] })).toBe('approvalPolicyNoApprovers');
    expect(approvalPolicyProblem({ ...on, approverRoles: [], approverGroupIds: [2] })).toBeNull();
    expect(approvalPolicyProblem({ ...on, scope: 'areas' })).toBe('approvalPolicyNoAreas');
    expect(approvalPolicyProblem({ ...on, scope: 'tags' })).toBe('approvalPolicyNoTags');
    expect(approvalPolicyProblem({ ...on, scope: 'tags', tags: ['has space'] })).toBe(
      'approvalPolicyTagInvalid',
    );
  });
});

describe('policyCovers', () => {
  const on = { ...DEFAULT_APPROVAL_POLICY, enabled: true };

  it('covers nothing while off, and everything when told to', () => {
    expect(policyCovers(DEFAULT_APPROVAL_POLICY, 'hosts', [])).toBe(false);
    for (const area of ['hosts', 'accessLists', 'waf', 'settings'] as const) {
      expect(policyCovers(on, area, [])).toBe(true);
    }
  });

  it('covers the areas named, and host changes touching a named tag', () => {
    const areas = { ...on, scope: 'areas' as const, areas: ['waf' as const] };
    expect(policyCovers(areas, 'waf', [])).toBe(true);
    expect(policyCovers(areas, 'hosts', ['payments'])).toBe(false);
    const tags = { ...on, scope: 'tags' as const, tags: ['payments'] };
    expect(policyCovers(tags, 'hosts', ['Payments'])).toBe(true);
    expect(policyCovers(tags, 'hosts', ['blog'])).toBe(false);
    expect(policyCovers(tags, 'settings', ['payments'])).toBe(false);
  });
});

describe('the catalogue of change kinds', () => {
  it('defines every kind it lists, each in one area', () => {
    expect(Object.keys(CHANGE_KIND_DEFINITIONS).sort()).toEqual([...CHANGE_KINDS].sort());
    expect(isChangeKind('proxyHostUpdate')).toBe(true);
    expect(isChangeKind('dropDatabase')).toBe(false);
  });

  it('tells an action result held for approval from one that applied', () => {
    expect(isSubmittedForApproval({ submittedForApproval: 4, message: 'x' })).toBe(true);
    expect(isSubmittedForApproval({ id: 4 })).toBe(false);
    expect(isSubmittedForApproval(null)).toBe(false);
  });
});

describe('the catalog', () => {
  it('words every kind, status and outcome the page composes a key for', async () => {
    const { changeApprovals, nav } = (await import('../../../messages/en.json'))
      .default as unknown as {
      changeApprovals: Record<string, Record<string, unknown>>;
      nav: Record<string, unknown>;
    };
    const { CHANGE_STATUSES } = await import('../../../src/lib/approvals/types');
    const { APPROVAL_AREAS, APPROVAL_SCOPES } = await import('../../../src/lib/approvals/policy');
    for (const kind of CHANGE_KINDS) expect(changeApprovals.kinds[kind]).toBeString();
    for (const status of CHANGE_STATUSES) {
      expect(changeApprovals.statuses[status]).toBeString();
      expect(changeApprovals.results[status]).toBeString();
    }
    for (const area of APPROVAL_AREAS) expect(nav[area]).toBeString();
    const policy = changeApprovals.policy as Record<string, Record<string, unknown>>;
    for (const scope of APPROVAL_SCOPES) {
      expect(policy.scopes[scope]).toBeString();
      expect(policy.scopeHelp[scope]).toBeString();
    }
  });
});
