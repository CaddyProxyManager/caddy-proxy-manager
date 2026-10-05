/**
 * A complete OAuth sign-in against a real OIDC provider, in the fast suite. Only e2e caught
 * `advanced.database.joins` breaking the callback: the drizzle adapter appends "s" to our
 * already-plural model names and asks for `accountss`, so joins stay off.
 * Needs the mock IdP (tests/helpers/mock-idp.ts); skips with a note when it is not running.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadConfig } from '@/tests/helpers/config';
import { reloadDbModule } from '@/tests/helpers/fresh-db';
import {
  MOCK_IDP_CLAIMS,
  MOCK_IDP_ISSUER,
  completeOAuthSignIn,
  isMockIdpReachable,
} from '@/tests/helpers/mock-idp';

const IDP_AVAILABLE = await isMockIdpReachable();
if (!IDP_AVAILABLE) {
  console.log(
    `[oauth-flow] mock IdP not reachable at ${MOCK_IDP_ISSUER} - skipping. ` +
      'See tests/helpers/mock-idp.ts for the one-line docker command.',
  );
}

const PROVIDER_ID = 'mock';
const cleanups: Array<() => void | Promise<void>> = [];

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  // Back to the suite-wide database, not deleted: connection.ts throws at import without one.
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
  resetDbModuleState();
});

/** Boot the app against a fresh database with the mock IdP registered as an env provider. */
async function bootWithMockProvider() {
  // A database of its own, not one of the per-test schemas: this boots the real db module, which
  // reads DATABASE_URL and opens its own connection.
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());

  process.env.DATABASE_URL = database.url;
  // runEnvProviderSync() below is one of the startup migrations the suite otherwise suppresses.
  delete process.env.CPM_EPHEMERAL_DB;
  // runEnvProviderSync() turns these into the oauth_providers row on db load. The slugified
  // provider name becomes the provider id.
  process.env.OAUTH_ENABLED = 'true';
  process.env.OAUTH_PROVIDER_NAME = 'Mock';
  process.env.OAUTH_CLIENT_ID = 'cpm';
  process.env.OAUTH_CLIENT_SECRET = 'secret';
  process.env.OAUTH_ISSUER = MOCK_IDP_ISSUER;
  process.env.AUTH_ALLOW_OAUTH_REGISTRATION = 'true';
  // Better Auth's limiter counts every sign-in attempt in-process, so a handful of tests in one
  // file trip it and the second one onwards fails with 429 rather than anything meaningful.
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  resetDbModuleState();

  // config.ts reads OAUTH_* once at module load, and db/index.ts's runEnvProviderSync() asks it whether
  // OAuth is configured. A cached copy evaluated before these variables were set reports disabled,
  // no provider row is written, and sign-in fails with PROVIDER_NOT_FOUND. Re-read it first.
  await reloadConfig();

  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());

  const authServer = await import('@/src/lib/auth/server');
  // Or getAuth() hands back the instance built on the previous test's database.
  authServer.invalidateProviderCache();
  const auth = (await authServer.getAuth()) as any;
  return { auth, db: dbModule.default, schema };
}

describe.if(IDP_AVAILABLE)('OAuth sign-in against a real IdP', () => {
  it('completes the callback and provisions the federated user', async () => {
    const { auth, db, schema } = await bootWithMockProvider();

    const result = await completeOAuthSignIn(auth, { providerId: PROVIDER_ID });
    expect(result.location).not.toContain('error');
    expect(result.ok).toBe(true);

    const users = await db.select().from(schema.users);
    const federated = users.find((user) => user.email === MOCK_IDP_CLAIMS.email);
    expect(federated, 'OAuth sign-in should have created the user').toBeDefined();
  });

  it('writes the linked account row keyed by the provider subject', async () => {
    const { auth, db, schema } = await bootWithMockProvider();
    await completeOAuthSignIn(auth, { providerId: PROVIDER_ID });

    const accounts = await db.select().from(schema.accounts);
    const linked = accounts.find((account) => account.accountId === MOCK_IDP_CLAIMS.sub);
    expect(linked, 'the OAuth identity should be linked to an account row').toBeDefined();
    expect(linked?.providerId).toBe(PROVIDER_ID);
    // better-auth keys external identities by (providerId, accountId), so a blank accountId here
    // means the account exists but will never resolve at the next sign-in.
    expect(linked?.accountId).toBeTruthy();
  });

  it('ignores a role claim from the IdP', async () => {
    // The mock returns role:"admin". Better Auth's generic-OAuth signup spreads raw claims into
    // the new user and ignores `input: false`, so enforceSafeUserDefaults has to override it.
    const { auth, db, schema } = await bootWithMockProvider();
    await completeOAuthSignIn(auth, { providerId: PROVIDER_ID });

    const users = await db.select().from(schema.users);
    const federated = users.find((user) => user.email === MOCK_IDP_CLAIMS.email);
    expect(federated?.role).toBe('user');
    expect(federated?.status).toBe('active');
  });

  it('issues a session the app can then read back', async () => {
    const { auth, db, schema } = await bootWithMockProvider();
    const result = await completeOAuthSignIn(auth, { providerId: PROVIDER_ID });

    const sessions = await db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);

    const session = await auth.api.getSession({ headers: new Headers({ cookie: result.cookie }) });
    expect(session?.user?.email).toBe(MOCK_IDP_CLAIMS.email);
  });
});
