/**
 * Every server action and REST handler makes a permission check, so one that forgets fails here
 * instead of answering whoever asks. The few that need only a signed-in account, or none, are
 * named below with the reason; a new one has to be added on purpose. GraphQL resolvers are held
 * to the same rule by `tests/integration/roles/permission-parity.test.ts`, which calls each one.
 */
import { describe, expect, it } from 'bun:test';
import { restHandlers, serverActions } from '../../helpers/entry-points';

/**
 * What counts as checking the caller's permissions: `lib/users/permissions.ts` asked directly, or
 * `requireApiUser`, which checks a REST route's role and token by its path.
 */
const PERMISSION_CHECK =
  /\b(requireCan|requireCanAccess|requireReach|requireApiUser|sessionCan)\(|\bcurrentAccess\(\)[\s\S]*\bcan(Reach)?\(/;

/** Enough to know who is asking. */
const SIGNED_IN = /\b(requireUser|requireApiUser|auth|getSession|currentAccess)\(/;

/** Each acts on the caller's own account, which every role may. */
const SIGNED_IN_ONLY: Record<string, string> = {
  'app/(dashboard)/api-tokens/actions.ts#createApiTokenAction': 'own tokens',
  'app/(dashboard)/api-tokens/actions.ts#deleteApiTokenAction': 'own tokens',
  'app/(dashboard)/more/actions.ts#saveMoreDrawerPinsAction': 'own drawer',
  'app/(dashboard)/profile/display-actions.ts#saveTableDensityAction': 'own preference',
  'app/(dashboard)/profile/display-actions.ts#saveDisplayPreferencesAction': 'own preference',
  'app/(dashboard)/profile/session-actions.ts#revokeSessionAction': 'own sessions',
  'app/(dashboard)/profile/session-actions.ts#revokeOtherSessionsAction': 'own sessions',
  'app/(dashboard)/view-as/actions.ts#stopViewAsAction': 'ends a narrowing on its own session',
  'app/(dashboard)/view-as/actions.ts#startViewAsAction':
    'narrows its own session; only the built-in administrator, who holds everything, may',
  'app/(dashboard)/users/access-reviews/actions.ts#decideAccessReviewItemAction':
    "a reviewer needs no capability; decideItem takes only the caller's own items",
  'app/(dashboard)/approvals/actions.ts#approveChangeAction':
    'the approval policy, not a capability, names approvers; approveChange checks it',
  'app/(dashboard)/approvals/actions.ts#rejectChangeAction':
    'the approval policy, not a capability, names approvers; rejectChange checks it',
  'app/(dashboard)/approvals/actions.ts#withdrawChangeAction':
    "own request; withdrawChange takes only the caller's",
  'app/(dashboard)/approvals/actions.ts#bypassChangeAction':
    'only the built-in administrator, which bypassChange checks',
  'app/(dashboard)/overview-actions.ts#loadAttentionAction':
    'collectAttention keeps only items the caller may see',
  'GET /api/v1/dns-providers': 'a static catalog without credentials',
  'GET /api/v1/sessions': 'own sessions',
  'DELETE /api/v1/sessions': 'own sessions',
  'DELETE /api/v1/sessions/[id]': 'own sessions',
  'GET /api/v1/tokens': 'own tokens, everyone else only with the permission',
  'POST /api/v1/tokens': 'own tokens',
  'DELETE /api/v1/tokens/[id]': 'own tokens, everyone else only with the permission',
  'GET /api/v1/users/[id]': 'own account, anyone else only with the permission',
  'POST /api/forward-auth/session-login': 'the portal: any account, checked per host',
  'POST /api/user/change-password': 'own account',
  'POST /api/user/remove-password': 'own account',
  'POST /api/user/unlink-oauth': 'own account',
  'POST /api/user/update-avatar': 'own account',
  'GET /api/auth/[...all]': 'the sign-in library',
  'POST /api/auth/[...all]': 'the sign-in library',
};

/** Reached before there is an account, or authenticated some other way. */
const NO_ACCOUNT: Record<string, string> = {
  'app/setup/actions.ts#createFirstAdmin': 'setup, refused once an account exists',
  'app/setup/actions.ts#configureFirstOAuthProvider': 'setup, refused once an account exists',
  'app/setup/migrate/actions.ts#skipMigration': 'setup, refused once setup completes',
  'GET /api/agent/geoip/[edition]': 'agent signature',
  'POST /api/agent/v1/pair/preview': 'pairing code',
  'POST /api/agent/v1/pair': 'pairing code',
  'POST /api/auth/logout': 'ends whatever session it carries',
  'PUT /api/auth/[...all]': 'SCIM, by its connection token',
  'PATCH /api/auth/[...all]': 'SCIM, by its connection token',
  'DELETE /api/auth/[...all]': 'SCIM, by its connection token',
  'GET /api/auth/oidc/backchannel-logout': 'identity provider logout token',
  'POST /api/auth/oidc/backchannel-logout': 'identity provider logout token',
  'GET /api/branding/favicon': 'public asset',
  'GET /api/forward-auth/callback': 'forward auth exchange',
  'POST /api/forward-auth/login': 'forward auth sign-in',
  'POST /api/forward-auth/login/verify': 'forward auth sign-in',
  'GET /api/forward-auth/verify': 'forward auth check, per host',
  'GET /api/graphql': 'each resolver checks; see permission-parity.test.ts',
  'POST /api/graphql': 'each resolver checks; see permission-parity.test.ts',
  'GET /api/health': 'health check',
  'POST /api/internal/enable-user': 'console command token',
  'POST /api/internal/lift-mfa-policy': 'console command token',
  'POST /api/internal/lift-sso-enforcement': 'console command token',
  'POST /api/internal/reset-2fa': 'console command token',
  'POST /api/password-reset/complete': 'reset token',
  'POST /api/password-reset/inspect': 'reset token',
  'POST /api/password-reset/request': 'rate limited, answers alike for any address',
  'POST /api/setup/migrate': 'setup, refused once setup completes',
  'POST /api/sign-in/captcha': 'before sign-in',
};

const entries = [...serverActions(), ...restHandlers()];

describe('entry points', () => {
  it('are all found', () => {
    expect(serverActions().length).toBeGreaterThan(150);
    expect(restHandlers().length).toBeGreaterThan(150);
  });

  it("each check the caller's permissions", () => {
    const unchecked = entries
      .filter((entry) => !(entry.id in SIGNED_IN_ONLY) && !(entry.id in NO_ACCOUNT))
      .filter((entry) => !PERMISSION_CHECK.test(entry.body))
      .map((entry) => entry.id);
    expect(unchecked).toEqual([]);
  });

  it('that need only an account at least ask who is calling', () => {
    const anonymous = entries
      .filter((entry) => entry.id in SIGNED_IN_ONLY)
      .filter((entry) => !SIGNED_IN.test(entry.body) && !PERMISSION_CHECK.test(entry.body))
      .map((entry) => entry.id);
    expect(anonymous).toEqual([]);
  });

  it('are named in the lists above only while they exist', () => {
    const known = new Set(entries.map((entry) => entry.id));
    const stale = [...Object.keys(SIGNED_IN_ONLY), ...Object.keys(NO_ACCOUNT)].filter(
      (id) => !known.has(id),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * Where the code still asks for a role by name. None is a permission check: each is about the
 * built-in administrator as a person (who is notified, who must enroll a second factor, who may
 * never be the last to go), which no capability expresses.
 */
const ROLE_BY_NAME: Record<string, string> = {
  'app/(dashboard)/profile/page.tsx': 'notifications go to administrators',
  'app/(dashboard)/users/UsersClient.tsx': 'the second-factor policy names administrators',
  'app/(dashboard)/view-as/actions.ts': 'view-as narrows from everything',
  'components/users/ViewAsDialog.tsx': 'picks the roles groups apply to',
  'lib/approvals/index.ts': "an emergency bypass is the built-in administrator's",
  'lib/auth/account-failures.ts': 'a locked administrator is reported',
  'lib/auth/two-factor/mfa-policy.ts': 'the second-factor policy names administrators',
  'lib/email/certificate-alerts.ts': 'certificate alerts go to administrators',
  'lib/models/groups.ts': 'a group never gives the administrator role',
  'lib/models/user.ts': 'the last administrator cannot be demoted',
  'lib/notifications/audience.ts': 'notifications go to administrators',
  'lib/scim/connections.ts': 'a provisioned group never gives the administrator role',
  'lib/scim/plugin.ts': 'the last administrator cannot be disabled; no group gives admin',
  'lib/services/oidc-group-sync.ts': 'the last administrator cannot be demoted',
  'lib/users/view-as.ts': 'view-as narrows from everything',
};

describe('roles named in code', () => {
  it('are never a permission check', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative, sep } = await import('node:path');
    const { SRC_ROOT } = await import('../../helpers/entry-points');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(entry) ? [path] : [];
      });
    const comparison =
      /\b\w*[rR]ole\)?\s*[!=]==\s*"(admin|operator|user|viewer)"|"(admin|operator|user|viewer)"\s*[!=]==\s*[\w.]*[rR]ole\b/;
    const found = walk(SRC_ROOT)
      .filter((file) => comparison.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
      .filter((file) => !(file in ROLE_BY_NAME));
    expect(found).toEqual([]);
  });
});
