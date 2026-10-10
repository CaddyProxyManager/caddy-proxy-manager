import { authPolicy } from "./policy";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { genericOAuth, twoFactor, username } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { announce, onAnnouncement } from "../cluster/announcements";
import db from "../db";
import * as schema from "../db/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { config } from "../config";
import { extraTrustedOrigins } from "./trusted-origins";
import { getPublicBaseUrl, publicOrigins } from "../http/public-url";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets";
import type { OAuthProvider } from "../models/oauth-providers";
import { withRoleGroups } from "../roles/mappings";
import type { GenericOAuthConfig } from "better-auth/plugins";
import {
  extractGroups,
  mapGroupsToLocalGroups,
  mapGroupsToRole,
  claimsNeeded,
  needsGroupClaims,
  toGroupMappingConfig,
} from "./oidc/groups";
import { fetchOidcClaims, toOAuthUserInfo } from "./oidc/claims";
import { recordPendingOidcSync, reconcileOidcUserAfterSignIn } from "../services/oidc-group-sync";
import { bindSessionToIdpSession, recordSessionBindingFromIdToken } from "../services/oidc-logout";
import { APIError, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
// The class the passkey plugin re-throws as is; better-auth's own copy it wraps as a generic 400.
import { APIError as PluginAPIError } from "@better-auth/core/error";
import { hashPassword, verifyPassword } from "./password";
import { MIN_PASSWORD_LENGTH } from "./password/policy";
import { PASSWORD_POLICY_CODE, SIGN_UP_EMAIL_PATH, signUpPasswordError } from "./signup-policy";
import { DISABLED_AUTH_PATHS } from "./disabled-paths";
import { getAppName } from "../branding/app-name";
import { DomainError } from "../errors/domain-error";
import { isValidLoginUsername, LOGIN_USERNAME_MAX_LENGTH } from "./login-username";
import {
  hasTwoFactorChallengeCookie,
  isCredentialSignInPath,
  isPasskeyRegisterPath,
  LDAP_SIGN_IN_PATH,
  isPasskeySignInPath,
  isTwoFactorVerifyPath,
} from "./sign-in-paths";
import { FRESH_SESSION_MAX_AGE_MS, isFreshSession } from "./session-age";
import { LDAP_PROVIDER_TYPE } from "../ldap/defaults";
import { findTwoFactorAfterHook, ldapSignIn } from "../ldap/plugin";
import { SSO_DISABLED_PATHS, guardSsoRequest, isSsoPath, samlSignIn } from "./saml/plugin";
import { SAML_PROVIDER_TYPE } from "./saml/urls";
import { scimGate } from "../scim/gate";
import { type SsoEnforcement, isBreakGlassAccount } from "./sso-enforcement";
import { getSsoEnforcement, isBreakGlassName } from "./sso-break-glass";
import {
  PASSKEY_NAME_MAX_LENGTH,
  isUserVerified,
  passkeyOrigins,
  passkeyRpId,
} from "./passkeys/relying-party";

// biome-ignore lint/suspicious/noExplicitAny: the type depends on a plugin list built at runtime
let cachedAuth: any = null;
let cachedProviders: GenericOAuthConfig[] | null = null;
let cachedTrustedProviderIds: string[] = [];

/** Better Auth reads only camelCase `emailVerified`, and some IdPs send the claim as a string. */
function profileEmailVerified(profile: Record<string, unknown>): boolean {
  const claim = profile.email_verified ?? profile.emailVerified;
  return claim === true || claim === "true";
}

/** Whether this finishes a profile "Link": only `/link-social` puts `link` in the state. */
async function isExplicitLinkCallback(): Promise<boolean> {
  try {
    return Boolean((await getOAuthState())?.link);
  } catch {
    return false;
  }
}

export function mapOAuthProvider(
  p: OAuthProvider,
  /** The environment's default is for callers outside a request. */
  allowOauthRegistration = config.auth.allowOauthRegistration,
): GenericOAuthConfig {
  // Verified only for auto-link providers, so a bare `email_verified: true` cannot claim a local
  // account - or for an explicit profile link, where the session already proves ownership. Every
  // mapProfileToUser must report this, or better-auth falls back to the ungated raw claim.
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
    // Gates first-time auto-provisioning only; linking still works.
    disableImplicitSignUp: !allowOauthRegistration,
    mapProfileToUser: (profile) => mapEmailVerified(profile),
  };
  if (p.authorizationUrl) cfg.authorizationUrl = p.authorizationUrl;
  if (p.tokenUrl) cfg.tokenUrl = p.tokenUrl;
  if (p.userinfoUrl) cfg.userInfoUrl = p.userinfoUrl;
  if (p.issuer) {
    if (!p.authorizationUrl && !p.tokenUrl) {
      cfg.discoveryUrl = `${p.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    }
  }

  const mapping = toGroupMappingConfig(p);
  if (needsGroupClaims(mapping)) {
    // better-auth stops at the ID token once it has sub and email; groups may be on userinfo.
    cfg.getUserInfo = async (tokens) => {
      const claims = await fetchOidcClaims(
        { issuer: p.issuer, userinfoUrl: p.userinfoUrl },
        { idToken: tokens.idToken, accessToken: tokens.accessToken },
        claimsNeeded(mapping),
      );
      if (!claims) return null;
      // Raw claims ride along for the group claim; OAuth2UserInfo declares only standard fields.
      return toOAuthUserInfo(claims) as unknown as Awaited<
        ReturnType<NonNullable<GenericOAuthConfig["getUserInfo"]>>
      >;
    };

    // Only parks the result: the user id is unknown here, so it applies at session creation.
    cfg.mapProfileToUser = (profile: Record<string, unknown>) => {
      const subject = profile.sub ?? profile.id;
      if (subject !== undefined && subject !== null) {
        const claimedGroups = extractGroups(profile, mapping.groupsClaim);
        // Roles come from their own claim when there is one; groups still come from the groups claim.
        const claimedRoles = mapping.rolesClaim
          ? extractGroups(profile, mapping.rolesClaim)
          : claimedGroups;
        recordPendingOidcSync({
          providerId: p.id,
          subject: String(subject),
          providerName: p.name,
          role: mapGroupsToRole(claimedRoles, mapping),
          localGroups: mapGroupsToLocalGroups(claimedGroups, mapping),
          claimedGroups,
          syncGroups: mapping.syncGroups,
        });
      }
      // The sync applies the role; the auto-link gate must still be reported, or group mapping
      // would hand it back to the IdP's own claim.
      return mapEmailVerified(profile);
    };
  }

  return cfg;
}

/**
 * Parks the IdP `sid` from the ID token, swallowing any failure: a missing `sid` costs only logout
 * precision, which is not worth refusing a sign-in over.
 */
function rememberIdpSession(
  account: { userId?: unknown; providerId?: unknown; idToken?: unknown },
  request: object | null | undefined,
) {
  try {
    if (typeof account.providerId !== "string" || account.providerId === "credential") return;
    if (typeof account.idToken !== "string") return;
    const userId = typeof account.userId === "string" ? Number(account.userId) : account.userId;
    if (typeof userId !== "number") return;
    recordSessionBindingFromIdToken(request, userId, account.providerId, account.idToken);
  } catch (error) {
    console.warn("[auth-server] Could not read the IdP session id from an ID token:", error);
  }
}

let providersLoadedSuccessfully = false;

async function loadProviders(): Promise<GenericOAuthConfig[]> {
  if (cachedProviders !== null && providersLoadedSuccessfully) return cachedProviders;

  // A failed load is retried on every call until it succeeds.
  try {
    const rows = await db
      .select()
      .from(schema.oauthProviders)
      .where(
        and(
          eq(schema.oauthProviders.enabled, true),
          // Directories and SAML providers share the table; each has a plugin of its own.
          notInArray(schema.oauthProviders.type, [LDAP_PROVIDER_TYPE, SAML_PROVIDER_TYPE]),
        ),
      );
    const providers: OAuthProvider[] = (await withRoleGroups(rows)).map((row) => ({
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
      rolesClaim: row.rolesClaim,
      groupPrefix: row.groupPrefix,
      roleMappingEnabled: row.roleMappingEnabled,
      adminGroup: row.adminGroup,
      operatorGroup: row.operatorGroup,
      userGroup: row.userGroup,
      viewerGroup: row.viewerGroup,
      roleGroups: row.roleGroups,
      defaultRole: row.defaultRole,
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
    // DB not ready yet; retried on the next getAuth().
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

type AuthHookContext = Parameters<typeof getSessionFromCtx>[0];

async function refusePasskey(
  status: "BAD_REQUEST" | "FORBIDDEN",
  code: string,
  key:
    | "passkeysDisabled"
    | "passkeyNameTooLong"
    | "passkeyReauthRequired"
    | "passkeyLastSignInMethod"
    | "passkeyNotVerified",
): Promise<never> {
  const { getTranslations } = await import("next-intl/server");
  const t = await getTranslations("auth.apiErrors");
  const message = t(key, {
    max: PASSKEY_NAME_MAX_LENGTH,
    minutes: FRESH_SESSION_MAX_AGE_MS / 60_000,
  });
  throw new PluginAPIError(status, { code, message });
}

/** The plugin checks each ceremony; this adds what CPM asks of an account on top. */
export async function guardPasskeyRequest(
  ctx: AuthHookContext,
  localUsersDisabled: boolean,
): Promise<void> {
  const path = ctx.path;
  // OIDC-only mode: the identity provider is the only way in, and a passkey is a local credential.
  if (localUsersDisabled && (isPasskeySignInPath(path) || isPasskeyRegisterPath(path))) {
    await refusePasskey("FORBIDDEN", "PASSKEYS_DISABLED", "passkeysDisabled");
  }
  const body =
    ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : null;
  if (typeof body?.name === "string" && body.name.trim().length > PASSKEY_NAME_MAX_LENGTH) {
    await refusePasskey("BAD_REQUEST", "PASSKEY_NAME_TOO_LONG", "passkeyNameTooLong");
  }

  if (isPasskeyRegisterPath(path)) {
    // Never a sign-in: a session minted here would restart the freshness clock below.
    if (body) delete body.createSession;
    // Better Auth's own freshness check allows a day; a stolen session must not add a way in.
    const session = await getSessionFromCtx(ctx);
    if (session && !isFreshSession({ createdAt: new Date(session.session.createdAt) })) {
      await refusePasskey("FORBIDDEN", "SESSION_NOT_FRESH", "passkeyReauthRequired");
    }
    return;
  }

  if (path === "/passkey/delete-passkey") {
    const session = await getSessionFromCtx(ctx);
    if (!session) return;
    const userId = Number(session.user.id);
    const { countUserPasskeys, keepsSignInMethod } = await import("./passkeys");
    // Ownership is the plugin's check, after this one.
    const left = Math.max(0, (await countUserPasskeys(userId)) - 1);
    if (!(await keepsSignInMethod(userId, left))) {
      await refusePasskey("BAD_REQUEST", "LAST_SIGN_IN_METHOD", "passkeyLastSignInMethod");
    }
  }
}

async function refuseWithoutSso(): Promise<never> {
  const { getTranslations } = await import("next-intl/server");
  const t = await getTranslations("auth.apiErrors");
  throw new PluginAPIError("FORBIDDEN", { code: "SSO_REQUIRED", message: t("ssoRequired") });
}

function bodyField(body: unknown, key: string): string {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

/**
 * While single sign-on is enforced: a password typed into CPM is refused before it is checked,
 * unless the name is a break-glass account's. A passkey names its account only once verified, so
 * that is refused at session creation instead (`refuseEnforcedPasskey`).
 */
export async function guardSsoEnforcement(ctx: AuthHookContext): Promise<void> {
  const path = ctx.path;
  const watched =
    path === "/sign-in/email" ||
    path === "/sign-in/username" ||
    path === LDAP_SIGN_IN_PATH ||
    path === SIGN_UP_EMAIL_PATH ||
    isPasskeyRegisterPath(path);
  if (!watched) return;
  const policy = await getSsoEnforcement();
  if (!policy.enforced) return;
  if (path === SIGN_UP_EMAIL_PATH) await refuseWithoutSso();
  if (isPasskeyRegisterPath(path)) {
    const session = await getSessionFromCtx(ctx);
    if (session && !isBreakGlassAccount(policy, Number(session.user.id))) await refuseWithoutSso();
    return;
  }
  // A directory's own sign-in, when allowed; its local-account fallback asks `localSignInAllowed`.
  if (path === LDAP_SIGN_IN_PATH && policy.allowLdap) return;
  const name = bodyField(ctx.body, path === "/sign-in/email" ? "email" : "username");
  if (!(await isBreakGlassName(policy, name))) await refuseWithoutSso();
}

async function refuseEnforcedPasskey(userId: number): Promise<void> {
  const policy: SsoEnforcement = await getSsoEnforcement();
  if (policy.enforced && !isBreakGlassAccount(policy, userId)) await refuseWithoutSso();
}

/** Called after the signature checks out: the plugin verifies without requiring UV. */
async function requireUserVerification(args: {
  verification: Parameters<typeof isUserVerified>[0];
}): Promise<void> {
  if (!isUserVerified(args.verification)) {
    await refusePasskey("BAD_REQUEST", "USER_NOT_VERIFIED", "passkeyNotVerified");
  }
}

// biome-ignore lint/suspicious/noExplicitAny: as cachedAuth above
async function createAuth(baseURL: string): Promise<any> {
  // Once per build; the settings action rebuilds via invalidateProviderCache after saving.
  const policy = await authPolicy();
  const oauthConfigs = await loadProviders();
  const appName = await getAppName();
  const trustedProviderIds = [...cachedTrustedProviderIds];
  // getAuth() rebuilds when the Public URL changes, so both follow it.
  const rpId = passkeyRpId(baseURL);
  // Empty fails every ceremony closed; null would let the plugin trust the request's Origin.
  const passkeyOriginList = rpId ? passkeyOrigins(rpId, await publicOrigins()) : [];
  // TOTP and backup codes only: a code by mail would come from the inbox a reset link opens.
  const twoFactorPlugin = twoFactor({
    issuer: appName,
    twoFactorTable: "twoFactors",
    backupCodeOptions: { storeBackupCodes: "encrypted" },
  });

  return betterAuth({
    // Keyed by export name, which matches each `modelName` below.
    database: drizzleAdapter(db, {
      provider: schema.schemaDialect === "sqlite" ? "sqlite" : "pg",
      schema: schema.activeSchema,
    }),
    secret: config.sessionSecret,
    // The Public URL: redirect URIs must match what the Settings page tells operators to register.
    baseURL,
    basePath: "/api/auth",
    // Opt-in: only for proxies that rewrite Host without setting X-Forwarded-Host.
    trustHost: policy.trustHost,
    // Adds the stored Public URL, and the browser's address during setup (auth/trusted-origins.ts).
    trustedOrigins: extraTrustedOrigins,
    advanced: {
      database: {
        generateId: "serial",
      },
      // Set by /api/auth from lib/http/client-ip.ts; X-Forwarded-For put every sign-in in one bucket.
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
      // "View as" (lib/users/view-as.ts): declared so getSession returns them; only the app writes them.
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
        // Providers with "Auto-link accounts" on.
        trustedProviders: trustedProviderIds,
        // No local email verification exists, so the default gate would refuse every link.
        requireLocalEmailVerified: false,
        // Explicit linking only; setup's `name@localhost` admin could otherwise never link.
        allowDifferentEmails: true,
      },
    },
    verification: { modelName: "verifications" },
    emailAndPassword: {
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
        if (isSsoPath(ctx.path)) {
          await guardSsoRequest(ctx);
          return;
        }
        await guardSsoEnforcement(ctx);
        if (ctx.path.startsWith("/passkey/")) {
          await guardPasskeyRequest(ctx, policy.disableLocalUsers);
          return;
        }
        // Checked first so every other auth request skips loading the translator.
        if (ctx.path !== SIGN_UP_EMAIL_PATH) return;
        // A registrant cannot choose a username (applySignInNameRules). Dropped before the
        // username plugin's hook, which would copy displayUsername in and say whether it is taken.
        if (ctx.body && typeof ctx.body === "object") {
          delete ctx.body.username;
          delete ctx.body.displayUsername;
        }
        const { getTranslations } = await import("next-intl/server");
        const message = signUpPasswordError(ctx.path, ctx.body, await getTranslations());
        if (message) throw new APIError("BAD_REQUEST", { message, code: PASSWORD_POLICY_CODE });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true opts out of enforceSafeUserDefaults.
          before: async (user: Record<string, unknown>, context?: { path?: string } | null) => {
            const { applySignInNameRules } = await import("../models/user");
            const selfRegistered = context?.path === SIGN_UP_EMAIL_PATH;
            let named: Record<string, unknown>;
            try {
              named = await applySignInNameRules(user, selfRegistered);
            } catch (error) {
              // The reply an existing email gets, whatever the reason, so names cannot be probed.
              if (selfRegistered && error instanceof DomainError) {
                throw new APIError("UNPROCESSABLE_ENTITY", {
                  message: "User already exists. Use another email.",
                  code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
                });
              }
              throw error;
            }
            if (policy.allowOauthRoleFromClaims) {
              return { data: named };
            }
            return { data: enforceSafeUserDefaults(named) };
          },
          after: async (user: { id: string | number }) => {
            // The user exists by now; a failure here must not fail the sign-up.
            try {
              const { releaseContestedSignInUsername } = await import("../models/user");
              await releaseContestedSignInUsername(Number(user.id));
            } catch (error) {
              console.warn("[auth-server] Checking the new user's username failed:", error);
            }
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
          after: async (account, context) => {
            // The session row does not exist yet, so `sid` is parked for the session hook below.
            rememberIdpSession(account, context);

            // The only password Better Auth writes itself; every other path is models/user.
            if (account.providerId === "credential" && account.password) {
              try {
                const { markPasswordChanged } = await import("../models/user");
                const userId =
                  typeof account.userId === "string" ? Number(account.userId) : account.userId;
                if (Number.isFinite(userId)) await markPasswordChanged(userId);
              } catch (e) {
                console.warn("[auth-server] Failed to record when the password was set:", e);
              }
            }

            // Better Auth writes only `accounts`; users.provider/subject derive from it (#261).
            try {
              const { syncUserOAuthIdentity } = await import("../models/user");
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
          after: async (account, context) => {
            // A repeat sign-in brings a fresh `sid` for a fresh session row.
            rememberIdpSession(account, context);

            // Repeat sign-ins update rather than create the row.
            try {
              const { syncUserOAuthIdentity } = await import("../models/user");
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
          // Refused as a wrong password is, so a disabled account's password is not confirmed.
          before: async (
            session: { userId: string | number },
            context?: { path?: string } | null,
          ) => {
            const [user] = await db
              .select({ status: schema.users.status })
              .from(schema.users)
              .where(eq(schema.users.id, Number(session.userId)))
              .limit(1);
            if (user?.status === "active") {
              if (!isPasskeySignInPath(context?.path)) return;
              await refuseEnforcedPasskey(Number(session.userId));
              // A directory user's passkey: only while a directory still vouches for them.
              const { directoryAccessWithdrawn } = await import("../models/ldap-directories");
              if (!(await directoryAccessWithdrawn(Number(session.userId)))) return;
            }
            throw new APIError(
              "UNAUTHORIZED",
              context?.path === "/sign-in/username" || context?.path === LDAP_SIGN_IN_PATH
                ? { message: "Invalid username or password", code: "INVALID_USERNAME_OR_PASSWORD" }
                : { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" },
            );
          },
          after: async (session, context) => {
            const userId =
              typeof session.userId === "string" ? Number(session.userId) : session.userId;
            // Created before 2FA decides it needs a code; the auth route audits the final one.
            if (isCredentialSignInPath(context?.path)) return;
            // Enabling 2FA rotates the session through verify; that is not a sign-in.
            if (
              isTwoFactorVerifyPath(context?.path) &&
              !hasTwoFactorChallengeCookie(context?.request?.headers.get("cookie"))
            ) {
              return;
            }

            // Before the audit entry, so the role is in effect for anything reading the session.
            try {
              await reconcileOidcUserAfterSignIn(userId);
            } catch (error) {
              console.warn("[auth-server] OIDC group sync failed:", error);
            }

            // So a back-channel logout naming `sid` ends this session and leaves the others.
            try {
              const sessionId =
                typeof session.id === "string" ? Number(session.id) : (session.id as number);
              await bindSessionToIdpSession(context, userId, sessionId);
            } catch (error) {
              console.warn("[auth-server] Binding the session to its IdP session failed:", error);
            }

            const { recordSignIn, sessionSignInMethod } = await import("./last-sign-in");
            const method = await sessionSignInMethod(userId, context?.path).catch(() => null);
            if (method) await recordSignIn(userId, method);

            try {
              const { createAuditEvent } = await import("../models/audit");
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
    disabledPaths: [...DISABLED_AUTH_PATHS, ...SSO_DISABLED_PATHS],
    plugins: [
      // Cast via unknown: the plugin's `email: string` vs BetterAuthPlugin's `email?: any`.
      username({
        maxUsernameLength: LOGIN_USERNAME_MAX_LENGTH,
        usernameValidator: isValidLoginUsername,
      }) as unknown as BetterAuthPlugin,
      genericOAuth({ config: oauthConfigs }),
      twoFactorPlugin as unknown as BetterAuthPlugin,
      // Its path is the plugin's own, so the TOTP step has to be wired to it by hand.
      ldapSignIn({
        twoFactorAfterHook: findTwoFactorAfterHook(twoFactorPlugin),
        localUsersEnabled: !policy.disableLocalUsers,
        allowRegistration: policy.allowOauthRegistration,
        localSignInAllowed: async (username) => {
          const enforcement = await getSsoEnforcement();
          return !enforcement.enforced || (await isBreakGlassName(enforcement, username));
        },
      }),
      samlSignIn({ allowRegistration: policy.allowOauthRegistration }),
      // Hands /scim/v2 to its own instance (lib/scim/auth.ts), or answers 501 under SQLite.
      scimGate(),
      passkey({
        // An unparseable Public URL: a hostname no browser will sign for, never "localhost".
        rpID: rpId ?? "invalid.",
        rpName: appName,
        origin: passkeyOriginList,
        // Discoverable, so the sign-in form needs no username; UV, so it stands for both factors.
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        schema: { passkey: { modelName: "passkeys" } },
        registration: { afterVerification: requireUserVerification },
        authentication: { afterVerification: requireUserVerification },
      }) as unknown as BetterAuthPlugin,
    ],
  });
}

let cachedBaseUrl: string | null = null;

export async function getAuth(): Promise<ReturnType<typeof betterAuth>> {
  // Every call: setup and Settings change it at runtime without a restart (the read is cached).
  const baseURL = await getPublicBaseUrl();

  if (cachedAuth && !providersLoadedSuccessfully) {
    cachedProviders = null;
    cachedAuth = null;
  }
  if (cachedAuth && cachedBaseUrl !== baseURL) {
    cachedAuth = null;
  }
  if (!cachedAuth) {
    // The promise, not the instance, or concurrent first requests each build their own.
    cachedBaseUrl = baseURL;
    cachedAuth = createAuth(baseURL);
  }
  return await cachedAuth;
}

onAnnouncement("oauth-providers", () => {
  cachedProviders = null;
  cachedTrustedProviderIds = [];
  providersLoadedSuccessfully = false;
  cachedAuth = null;
});

/** After a provider changes; every replica rebuilds Better Auth on its next request. */
export function invalidateProviderCache(): void {
  announce("oauth-providers");
}
