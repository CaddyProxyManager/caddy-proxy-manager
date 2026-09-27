import { authPolicy } from "./auth-policy";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { genericOAuth, twoFactor, username } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import db from "./db";
import * as schema from "./db/schema";
import { eq } from "drizzle-orm";
import { config } from "./config";
import { extraTrustedOrigins } from "./auth-trusted-origins";
import { getPublicBaseUrl } from "./public-url";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secret";
import type { OAuthProvider } from "./models/oauth-providers";
import type { GenericOAuthConfig } from "better-auth/plugins";
import {
  extractGroups,
  mapGroupsToLocalGroups,
  mapGroupsToRole,
  needsGroupClaims,
  toGroupMappingConfig,
} from "./oidc-groups";
import { fetchOidcClaims, toOAuthUserInfo } from "./oidc-claims";
import { recordPendingOidcSync, reconcileOidcUserAfterSignIn } from "./services/oidc-group-sync";
import { bindSessionToIdpSession, recordSessionBindingFromIdToken } from "./services/oidc-logout";
import { APIError, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { hashPassword, verifyPassword } from "./password";
import { MIN_PASSWORD_LENGTH } from "./password-policy";
import { SIGN_UP_EMAIL_PATH, signUpPasswordError } from "./auth-signup-policy";
import { DISABLED_AUTH_PATHS } from "./auth-disabled-paths";
import { getAppName } from "./app-name";
import {
  hasTwoFactorChallengeCookie,
  isCredentialSignInPath,
  isTwoFactorVerifyPath,
} from "./auth-sign-in-paths";

// biome-ignore lint/suspicious/noExplicitAny: better-auth infers its instance type from the plugin list, which is assembled at runtime from the providers table
let cachedAuth: any = null;
let cachedProviders: GenericOAuthConfig[] | null = null;
let cachedTrustedProviderIds: string[] = [];

/**
 * OIDC spells the claim `email_verified`; some providers serialize it as a
 * string. Better Auth's generic-OAuth profile reader only looks at a camelCase
 * `emailVerified` field, so the claim has to be mapped explicitly.
 */
function profileEmailVerified(profile: Record<string, unknown>): boolean {
  const claim = profile.email_verified ?? profile.emailVerified;
  return claim === true || claim === "true";
}

/**
 * Whether this OAuth callback finishes an explicit link: a signed-in user pressed "Link" on their
 * profile. better-auth parses the flow's state before it asks the provider for the profile, and
 * only `/link-social` puts `link` into that state. Outside a request there is no state to read.
 */
async function isExplicitLinkCallback(): Promise<boolean> {
  try {
    return Boolean((await getOAuthState())?.link);
  } catch {
    return false;
  }
}

export function mapOAuthProvider(
  p: OAuthProvider,
  /** From the stored policy. Defaults to the environment's answer, for callers outside a request. */
  allowOauthRegistration = config.auth.allowOauthRegistration,
): GenericOAuthConfig {
  // Two different questions reach better-auth's one "is this provider trusted" gate:
  //
  // - A sign-in claiming the CPM account with the same email. Ownership is asserted by the
  //   operator through the provider's auto-link switch, never by the IdP alone - reporting the
  //   claim only for auto-link providers keeps a provider that merely returns
  //   `email_verified: true` from attaching itself to someone's local account.
  // - An explicit link from the profile page. The session already proves who owns the CPM
  //   account and the provider login proves the identity, so no email trust is involved, and
  //   gating it on auto-link made manual linking impossible exactly where it is the only option.
  //
  // Every mapProfileToUser below must report this - better-auth otherwise falls back to the raw
  // profile's own emailVerified, which is exactly the ungated claim.
  const mapEmailVerified = async (profile: Record<string, unknown>) => ({
    emailVerified:
      (await isExplicitLinkCallback()) || (p.autoLink === true && profileEmailVerified(profile)),
  });

  const cfg: GenericOAuthConfig = {
    providerId: p.id,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    scopes: p.scopes ? p.scopes.split(/[\s,]+/).filter(Boolean) : undefined,
    pkce: true,
    // Security: an OAuth sign-in must not implicitly create an account unless OAuth
    // self-registration is on. Only first-time auto-provisioning is gated; linking still works.
    disableImplicitSignUp: !allowOauthRegistration,
    mapProfileToUser: (profile) => mapEmailVerified(profile),
  };
  if (p.authorizationUrl) cfg.authorizationUrl = p.authorizationUrl;
  if (p.tokenUrl) cfg.tokenUrl = p.tokenUrl;
  if (p.userinfoUrl) cfg.userInfoUrl = p.userinfoUrl;
  if (p.issuer) {
    // Only use discovery when explicit URLs are not provided
    if (!p.authorizationUrl && !p.tokenUrl) {
      cfg.discoveryUrl = `${p.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    }
  }

  const mapping = toGroupMappingConfig(p);
  if (needsGroupClaims(mapping)) {
    // Resolve claims ourselves so the group claim is found whether the IdP puts it in the ID
    // token or only on userinfo - better-auth stops at the ID token once it has sub and email.
    cfg.getUserInfo = async (tokens) => {
      const claims = await fetchOidcClaims(
        { issuer: p.issuer, userinfoUrl: p.userinfoUrl },
        { idToken: tokens.idToken, accessToken: tokens.accessToken },
        mapping.groupsClaim,
      );
      if (!claims) return null;
      // The raw claims ride along so mapProfileToUser can read the group claim; better-auth's
      // OAuth2UserInfo type declares only the standard fields.
      return toOAuthUserInfo(claims) as unknown as Awaited<
        ReturnType<NonNullable<GenericOAuthConfig["getUserInfo"]>>
      >;
    };

    // Runs on every sign-in through this provider, new and existing users alike. It only parks
    // the result: the user id isn't known here, so the mapping is applied at session creation.
    cfg.mapProfileToUser = (profile: Record<string, unknown>) => {
      const subject = profile.sub ?? profile.id;
      if (subject !== undefined && subject !== null) {
        const claimedGroups = extractGroups(profile, mapping.groupsClaim);
        recordPendingOidcSync({
          providerId: p.id,
          subject: String(subject),
          providerName: p.name,
          role: mapGroupsToRole(claimedGroups, mapping),
          localGroups: mapGroupsToLocalGroups(claimedGroups, mapping),
          claimedGroups,
          syncGroups: mapping.syncGroups,
        });
      }
      // Privileged fields are never taken from the profile (see enforceSafeUserDefaults); the
      // role is applied by the sync instead. The auto-link gate still has to be reported, or
      // enabling group mapping would quietly hand it back to the IdP's own claim.
      return mapEmailVerified(profile);
    };
  }

  return cfg;
}

/**
 * Park the IdP session id from an account row's ID token, ignoring anything that goes wrong.
 *
 * Both account hooks call this, and neither may fail over it: a provider that issues no `sid`,
 * or a token this cannot decode, costs precision on a future logout and nothing else - refusing
 * the sign-in over it would be far worse.
 */
function rememberIdpSession(account: {
  userId?: unknown;
  providerId?: unknown;
  idToken?: unknown;
}) {
  try {
    if (typeof account.providerId !== "string" || account.providerId === "credential") return;
    if (typeof account.idToken !== "string") return;
    const userId = typeof account.userId === "string" ? Number(account.userId) : account.userId;
    if (typeof userId !== "number") return;
    recordSessionBindingFromIdToken(userId, account.providerId, account.idToken);
  } catch (error) {
    console.warn("[auth-server] Could not read the IdP session id from an ID token:", error);
  }
}

/** Whether provider load succeeded at least once */
let providersLoadedSuccessfully = false;

async function loadProviders(): Promise<GenericOAuthConfig[]> {
  // If we have a successful cache, use it
  if (cachedProviders !== null && providersLoadedSuccessfully) return cachedProviders;

  // A cache left empty by a failed attempt is retried on every call until it succeeds
  try {
    const rows = await db
      .select()
      .from(schema.oauthProviders)
      .where(eq(schema.oauthProviders.enabled, true));
    const providers: OAuthProvider[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      clientId: decryptSecret(row.clientId, `OAuth provider "${row.name}"`),
      clientSecret: decryptSecret(row.clientSecret, `OAuth provider "${row.name}"`),
      issuer: row.issuer,
      authorizationUrl: row.authorizationUrl,
      tokenUrl: row.tokenUrl,
      userinfoUrl: row.userinfoUrl,
      scopes: row.scopes,
      autoLink: row.autoLink,
      enabled: row.enabled,
      source: row.source,
      groupsClaim: row.groupsClaim,
      groupPrefix: row.groupPrefix,
      roleMappingEnabled: row.roleMappingEnabled,
      adminGroup: row.adminGroup,
      operatorGroup: row.operatorGroup,
      userGroup: row.userGroup,
      viewerGroup: row.viewerGroup,
      defaultRole:
        row.defaultRole === "admin" || row.defaultRole === "viewer" ? row.defaultRole : "user",
      syncGroups: row.syncGroups,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    const { allowOauthRegistration } = await authPolicy();
    cachedProviders = providers.map((provider) =>
      mapOAuthProvider(provider, allowOauthRegistration),
    );
    cachedTrustedProviderIds = providers.filter((p) => p.autoLink).map((p) => p.id);
    providersLoadedSuccessfully = true;
  } catch (e) {
    // DB not ready yet - start with empty, will retry on next getAuth() call
    if (!cachedProviders) cachedProviders = [];
    console.warn("[auth-server] Failed to load OAuth providers (will retry):", e);
  }

  return cachedProviders;
}

/**
 * Security: force privileged fields to safe defaults on every better-auth-managed user creation.
 * Its generic-OAuth signup spreads raw IdP claims into the new user and ignores `input:false`, so
 * an IdP returning `role: "admin"` could self-provision one. models/user.ts bypasses these hooks.
 */
export function enforceSafeUserDefaults<T extends object>(
  user: T,
): T & { role: string; status: string } {
  return { ...user, role: "user", status: "active" };
}

// biome-ignore lint/suspicious/noExplicitAny: as cachedAuth above - the return type depends on a plugin list only known at runtime
async function createAuth(baseURL: string): Promise<any> {
  // Resolved once per build of the instance. `getAuth` rebuilds when these change - see the
  // note on invalidateProviderCache, which the settings action calls after saving them.
  const policy = await authPolicy();
  const oauthConfigs = await loadProviders();
  const appName = await getAppName();
  const trustedProviderIds = [...cachedTrustedProviderIds];

  return betterAuth({
    // Every table, keyed by its export name: the adapter resolves each model by the `modelName`
    // configured below, and those names already match.
    database: drizzleAdapter(db, {
      provider: schema.schemaDialect === "sqlite" ? "sqlite" : "pg",
      schema: schema.activeSchema,
    }),
    secret: config.sessionSecret,
    // The Public URL, not BASE_URL alone: OAuth redirect URIs are built from this, and they have to
    // match what the Settings page tells the operator to register.
    baseURL,
    basePath: "/api/auth",
    // Only trust the Host header when the operator explicitly opts in. baseURL already pins the
    // canonical origin; trustHost is needed only behind reverse proxies that rewrite Host
    // without setting X-Forwarded-Host.
    trustHost: policy.trustHost,
    // BASE_URL is trusted by Better Auth itself; this adds the stored Public URL, and the browser's
    // own address while setup is unfinished. See auth-trusted-origins.ts.
    trustedOrigins: extraTrustedOrigins,
    advanced: {
      database: {
        generateId: "serial",
      },
      // The /api/auth route sets this from lib/client-ip.ts, replacing any client-sent copy. Left on
      // X-Forwarded-For, a spoofed or multi-hop value put every sign-in into one shared bucket.
      ipAddress: {
        ipAddressHeaders: ["x-cpm-client-ip"],
      },
    } as Record<string, unknown>,
    rateLimit: policy.rateLimit,
    user: {
      modelName: "users",
      fields: {
        image: "avatarUrl",
      },
      additionalFields: {
        role: { type: "string", defaultValue: "user", input: false },
        status: { type: "string", defaultValue: "active", input: false },
        provider: { type: "string", defaultValue: "", input: false },
        subject: { type: "string", defaultValue: "", input: false },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: 7 * 24 * 60 * 60,
      cookieCache: { enabled: false },
      // "View as" (lib/view-as.ts). Declared so getSession returns them; only the app writes them.
      additionalFields: {
        viewAsRole: { type: "string", required: false, input: false },
        viewAsGroupIds: { type: "string", required: false, input: false },
        viewAsExpiresAt: { type: "string", required: false, input: false },
      },
    },
    account: {
      modelName: "accounts",
      accountLinking: {
        enabled: true,
        // A provider with "Auto-link accounts" enabled is trusted to prove that
        // its identity owns the CPM account carrying the same email address.
        trustedProviders: trustedProviderIds,
        // CPM has no local email-verification flow, so a user row's
        // emailVerified is never set and the default gate would refuse every
        // link. The per-provider trust decision above is the ownership signal.
        requireLocalEmailVerified: false,
        // Read only by explicit linking, where the session proves the account's owner. Without
        // it the administrator setup creates - `name@localhost` - could never link any provider.
        allowDifferentEmails: true,
      },
    },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      // OIDC-only mode turns credential sign-in off entirely - there are no local accounts.
      enabled: !policy.disableLocalUsers,
      disableSignUp: !policy.allowSelfRegistration,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      password: {
        async hash(password: string) {
          return hashPassword(password);
        },
        async verify({ hash, password }: { hash: string; password: string }) {
          return verifyPassword(password, hash);
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Checked first so every other auth request skips loading the translator.
        if (ctx.path !== SIGN_UP_EMAIL_PATH) return;
        const { getTranslations } = await import("next-intl/server");
        const message = signUpPasswordError(ctx.path, ctx.body, await getTranslations());
        if (message) throw new APIError("BAD_REQUEST", { message });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // By default, never let an external IdP set privileged fields (role/status) on a newly
          // federated user - see enforceSafeUserDefaults above. Operators who trust their IdP to
          // manage roles can opt out with AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true.
          before: async (user: Record<string, unknown>) => {
            if (policy.allowOauthRoleFromClaims) {
              return { data: user };
            }
            return { data: enforceSafeUserDefaults(user) };
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            const data = { ...account };
            if (data.accessToken) data.accessToken = encryptSecret(data.accessToken);
            if (data.refreshToken) data.refreshToken = encryptSecret(data.refreshToken);
            if (data.idToken) data.idToken = encryptSecret(data.idToken);
            return { data };
          },
          after: async (account) => {
            // The ID token is in hand here and the session row does not exist yet, so its `sid`
            // is parked for the session hook below - that is what a back-channel logout naming a
            // single IdP session has to match against.
            rememberIdpSession(account);

            // Self-registration is the one password Better Auth writes itself - its change and
            // reset endpoints are disabled, and every other path goes through models/user.
            if (account.providerId === "credential" && account.password) {
              try {
                const { markPasswordChanged } = await import("./models/user");
                const userId =
                  typeof account.userId === "string" ? Number(account.userId) : account.userId;
                if (Number.isFinite(userId)) await markPasswordChanged(userId);
              } catch (e) {
                console.warn("[auth-server] Failed to record when the password was set:", e);
              }
            }

            // Better Auth writes federated identities to the `accounts` table
            // only. Re-derive the informational users.provider/subject columns
            // from it so auto-linking, profile linking, and federated sign-up
            // are all reflected in the CPM user state (#261).
            try {
              const { syncUserOAuthIdentity } = await import("./models/user");
              const userId =
                typeof account.userId === "string" ? Number(account.userId) : account.userId;
              if (Number.isFinite(userId)) {
                await syncUserOAuthIdentity(userId);
              }
            } catch (e) {
              // Informational columns only - never break authentication over them.
              console.warn("[auth-server] Failed to sync users.provider/subject from accounts:", e);
            }
          },
        },
        update: {
          before: async (account) => {
            const data = { ...account };
            if (data.accessToken && !isEncryptedSecret(data.accessToken))
              data.accessToken = encryptSecret(data.accessToken);
            if (data.refreshToken && !isEncryptedSecret(data.refreshToken))
              data.refreshToken = encryptSecret(data.refreshToken);
            if (data.idToken && !isEncryptedSecret(data.idToken))
              data.idToken = encryptSecret(data.idToken);
            return { data };
          },
          after: async (account) => {
            // A repeat sign-in gets a fresh ID token with a fresh `sid`, and a fresh session row
            // to stamp with it.
            rememberIdpSession(account);

            // Repeat OAuth sign-ins update the existing account row rather than
            // creating one; keep the projection fresh in that path too.
            try {
              const { syncUserOAuthIdentity } = await import("./models/user");
              const userId =
                typeof account.userId === "string" ? Number(account.userId) : account.userId;
              if (Number.isFinite(userId)) {
                await syncUserOAuthIdentity(userId);
              }
            } catch (e) {
              console.warn("[auth-server] Failed to sync users.provider/subject from accounts:", e);
            }
          },
        },
      },
      session: {
        create: {
          after: async (session, context) => {
            const userId =
              typeof session.userId === "string" ? Number(session.userId) : session.userId;
            // Created before the 2FA plugin decides it needs a code, then deleted if so; the auth
            // route audits the final one.
            if (isCredentialSignInPath(context?.path)) return;
            // Turning 2FA on rotates the session through the verify endpoint; that isn't a sign-in.
            if (
              isTwoFactorVerifyPath(context?.path) &&
              !hasTwoFactorChallengeCookie(context?.request?.headers.get("cookie"))
            ) {
              return;
            }

            // Apply the IdP's group claim now that the user and account rows exist. Runs before
            // the audit entry so a role change is in effect for anything reading the session.
            try {
              await reconcileOidcUserAfterSignIn(userId);
            } catch (error) {
              console.warn("[auth-server] OIDC group sync failed:", error);
            }

            // Stamp the session with the IdP session it belongs to, so a back-channel logout
            // naming that `sid` can end this one and leave the user's others alone.
            try {
              const sessionId =
                typeof session.id === "string" ? Number(session.id) : (session.id as number);
              await bindSessionToIdpSession(userId, sessionId);
            } catch (error) {
              console.warn("[auth-server] Binding the session to its IdP session failed:", error);
            }

            try {
              const { createAuditEvent } = await import("./models/audit");
              await createAuditEvent({
                userId,
                action: "login_success",
                entityType: "session",
                entityId: null,
                summary: "User signed in",
              });
            } catch {
              // Don't break auth flow if audit logging fails
            }
          },
        },
      },
    },
    disabledPaths: DISABLED_AUTH_PATHS,
    plugins: [
      // Cast via unknown: better-auth's `username` plugin types `email: string` where
      // BetterAuthPlugin expects `email?: any`, and the mismatch is environment-dependent.
      username({
        maxUsernameLength: 255,
        usernameValidator: (username) => /^[a-zA-Z0-9_.@-]+$/.test(username),
      }) as unknown as BetterAuthPlugin,
      genericOAuth({ config: oauthConfigs }),
      // TOTP and backup codes only: there is no mail or SMS to send a one-time code with.
      twoFactor({
        issuer: appName,
        twoFactorTable: "twoFactors",
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }) as unknown as BetterAuthPlugin,
    ],
  });
}

/** The Public URL the cached instance was built with. */
let cachedBaseUrl: string | null = null;

export async function getAuth(): Promise<ReturnType<typeof betterAuth>> {
  // Read on every call - the settings module caches it, and clears that cache on save - because the
  // Public URL changes at runtime: setup and Settings both write it, and neither restarts the app.
  const baseURL = await getPublicBaseUrl();

  // Rebuild if providers failed to load initially and are now available
  if (cachedAuth && !providersLoadedSuccessfully) {
    cachedProviders = null;
    cachedAuth = null;
  }
  if (cachedAuth && cachedBaseUrl !== baseURL) {
    cachedAuth = null;
  }
  if (!cachedAuth) {
    // Cache the promise, not the resolved instance: concurrent first requests would otherwise each
    // build their own Better Auth instance and the last one to finish would win.
    cachedBaseUrl = baseURL;
    cachedAuth = createAuth(baseURL);
  }
  return await cachedAuth;
}

export function invalidateProviderCache(): void {
  cachedProviders = null;
  cachedTrustedProviderIds = [];
  providersLoadedSuccessfully = false;
  cachedAuth = null;
}
