import { passwordPolicyViolationsInEnglish } from "./password-policy-message";

const DEV_SECRET = "dev-secret-change-in-production-12345678901234567890123456789012";
const DEFAULT_ADMIN_PASSWORD = "admin";
/** Publicly known: refused at startup, yet still tried for decryption so their data can move off. */
export const DISALLOWED_SESSION_SECRETS: ReadonlySet<string> = new Set([
  "change-me-in-production",
  "dev-secret-change-in-production-12345678901234567890123456789012",
  // .env.example
  "your-secure-session-secret-here-min-32-chars",
]);
/** Examples from .env.example and the README, current and past. They pass the password policy. */
const DISALLOWED_ADMIN_PASSWORDS: ReadonlySet<string> = new Set([
  "Your-Secure-P@ssw0rd-Here!",
  "YourStr0ng-P@ssw0rd123!",
  "YourStr0ng-P@ssw0rd!",
  "Your-Str0ng-P@ssw0rd!",
]);
const MIN_SESSION_SECRET_LENGTH = 32;
const DEFAULT_APP_NAME = "Caddy Proxy Manager";

function resolveLegacyPasswordChangeEnv(): boolean | null {
  const raw = process.env.AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH?.trim().toLowerCase();
  if (raw === undefined || raw === "") return null;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

/** AVATAR_GRAVATAR pins it and locks the toggle, so air-gapped browsers never hit gravatar.com. */
function resolveGravatarEnv(): boolean | null {
  const raw = process.env.AVATAR_GRAVATAR?.trim().toLowerCase();
  if (raw === undefined || raw === "") return null;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

type Runtime = {
  /** OIDC-only mode: no local accounts, no bootstrap admin, no credential sign-in. */
  localUsersDisabled: boolean;
  isProduction: boolean;
  isNodeRuntime: boolean;
  isDevelopment: boolean;
  isRuntimeProduction: boolean;
};

function readRuntime(): Runtime {
  const isDevelopment = process.env.NODE_ENV === "development";
  const isNodeRuntime = process.env.NEXT_RUNTIME === "nodejs";
  const isBuildPhase =
    process.env.NEXT_PHASE === "phase-production-build" || !process.env.NEXT_RUNTIME;
  return {
    localUsersDisabled: process.env.AUTH_DISABLE_LOCAL_USERS === "true",
    isProduction: process.env.NODE_ENV === "production",
    isNodeRuntime,
    isDevelopment,
    // Any NODE_ENV but development, so "staging" or a typo does not skip the checks.
    isRuntimeProduction: !isDevelopment && isNodeRuntime && !isBuildPhase,
  };
}

function resolveSessionSecret({
  isDevelopment,
  isProduction,
  isNodeRuntime,
  isRuntimeProduction,
}: Runtime): string {
  const rawSecret = process.env.SESSION_SECRET ?? null;
  const secret = rawSecret?.trim();

  if (isDevelopment && !secret) {
    return DEV_SECRET;
  }

  if (isProduction && !isNodeRuntime && !secret) {
    return DEV_SECRET;
  }

  // Fail-closed on unrecognized NODE_ENV to prevent silent DEV_SECRET usage
  if (!isDevelopment && !isProduction && !secret) {
    throw new Error(
      `SESSION_SECRET is required when NODE_ENV="${process.env.NODE_ENV ?? ""}" ` +
        `(not "development" or "production"). ` +
        "Generate a secure secret with: openssl rand -base64 32",
    );
  }

  const finalSecret = secret || DEV_SECRET;

  if (isRuntimeProduction) {
    if (!secret) {
      throw new Error(
        "SESSION_SECRET environment variable is required in production. " +
          "Generate a secure secret with: openssl rand -base64 32",
      );
    }
    if (DISALLOWED_SESSION_SECRETS.has(secret)) {
      throw new Error(
        "SESSION_SECRET is using a known insecure placeholder value. " +
          "Generate a secure secret with: openssl rand -base64 32. " +
          "Secrets stored under the placeholder are re-encrypted with the new one automatically on the next start; " +
          "for any other rotation, put the old value in SESSION_SECRET_PREVIOUS.",
      );
    }
    if (secret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters long in production. ` +
          "Generate a secure secret with: openssl rand -base64 32",
      );
    }
  }

  return finalSecret;
}

/**
 * Absent credentials mean an unconfigured deployment, which runs first-run setup (./setup.ts)
 * rather than failing. Present ones must still be good: a weak ADMIN_PASSWORD silently produces a
 * reachable account, which is worse than no seed.
 */
function resolveAdminCredentials({ localUsersDisabled, isRuntimeProduction }: Runtime): {
  username: string | null;
  password: string | null;
} {
  if (localUsersDisabled) {
    return { username: null, password: null };
  }

  const username = process.env.ADMIN_USERNAME?.trim() || null;
  const password = process.env.ADMIN_PASSWORD?.trim() || null;

  if (!username && !password) {
    return { username: null, password: null };
  }

  const errors: string[] = [];
  if (!username) errors.push("ADMIN_USERNAME must be set alongside ADMIN_PASSWORD");
  if (!password) {
    errors.push("ADMIN_PASSWORD must be set alongside ADMIN_USERNAME");
  } else if (isRuntimeProduction && process.env.DEMO_MODE?.trim().toLowerCase() !== "true") {
    // Runtime only: the production build imports this with whatever the image carries.
    if (password === DEFAULT_ADMIN_PASSWORD) {
      errors.push("ADMIN_PASSWORD must not be 'admin'");
    } else if (DISALLOWED_ADMIN_PASSWORDS.has(password)) {
      errors.push("ADMIN_PASSWORD is an example value from the documentation; choose your own");
    } else {
      for (const failure of passwordPolicyViolationsInEnglish(password)) {
        errors.push(`ADMIN_PASSWORD ${failure}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      "Admin credentials validation failed:\n" +
        errors.map((e) => `  - ${e}`).join("\n") +
        "\n\nLeave both unset to create the first account through the setup flow instead.",
    );
  }

  return { username, password };
}

/**
 * Comma-separated; the whole value is kept as one entry too, in case a secret contains a comma.
 * Never checked like SESSION_SECRET: it only ever decrypts.
 */
function resolvePreviousSessionSecrets(): string[] {
  const raw = process.env.SESSION_SECRET_PREVIOUS?.trim();
  if (!raw) return [];
  const entries = [raw, ...raw.split(",").map((entry) => entry.trim())];
  return [...new Set(entries.filter(Boolean))];
}

/**
 * Reads the environment when called. The module reads it once, at import; a test stubs the
 * environment and calls this again rather than evaluating a second copy of the module.
 */
export function readConfig() {
  const runtime = readRuntime();
  let _adminCredentials: { username: string | null; password: string | null } | null = null;
  let _sessionSecret: string | null = null;
  const adminCredentials = () => (_adminCredentials ??= resolveAdminCredentials(runtime));
  const sessionSecret = () => (_sessionSecret ??= resolveSessionSecret(runtime));

  const config = {
    get sessionSecret() {
      return sessionSecret();
    },
    /** Keys a rotation left behind, tried for decryption only. Read per access so tests can vary it. */
    get previousSessionSecrets(): string[] {
      return resolvePreviousSessionSecrets();
    },
    caddyApiUrl:
      process.env.CADDY_API_URL ??
      (process.env.NODE_ENV === "development" ? "http://localhost:2019" : "http://caddy:2019"),
    baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
    /**
     * Display name in the sidebar, on the login card, and as the page-title suffix. A page opts out
     * with `title: { absolute: ... }` - see app/layout.tsx.
     */
    appName: process.env.APP_NAME?.trim() || DEFAULT_APP_NAME,
    /**
     * Null rather than a default: it seeds the dashboard host once at setup, and "unset" must stay
     * distinguishable so BASE_URL's hostname can be the fallback.
     */
    dashboardDomain: process.env.DASHBOARD_DOMAIN?.trim() || null,
    avatars: {
      /** true/false when AVATAR_GRAVATAR pins it, null when the setting decides. */
      gravatarFromEnv: resolveGravatarEnv(),
    },
    get adminUsername() {
      return adminCredentials().username;
    },
    get adminPassword() {
      return adminCredentials().password;
    },
    auth: {
      disableLocalUsers: runtime.localUsersDisabled,
      allowSelfRegistration:
        !runtime.localUsersDisabled && process.env.AUTH_ALLOW_SELF_REGISTRATION === "true",
      // Separate from credential self-registration. Closed by default, except in OIDC-only mode,
      // where the IdP is the only way an account can exist.
      allowOauthRegistration: runtime.localUsersDisabled
        ? process.env.AUTH_ALLOW_OAUTH_REGISTRATION !== "false"
        : process.env.AUTH_ALLOW_OAUTH_REGISTRATION === "true",
      // Lets IdP claims set a new user's role/status; enable only if you control the IdP.
      allowOauthRoleFromClaims: process.env.AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS === "true",
      // For pre-argon2id bcrypt hashes; null when the stored setting decides.
      requirePasswordChangeOnLegacyHashFromEnv: resolveLegacyPasswordChangeEnv(),
    },
    oauth: {
      enabled: process.env.OAUTH_ENABLED === "true",
      providerName: process.env.OAUTH_PROVIDER_NAME ?? "OAuth2",
      clientId: process.env.OAUTH_CLIENT_ID ?? null,
      clientSecret: process.env.OAUTH_CLIENT_SECRET ?? null,
      issuer: process.env.OAUTH_ISSUER ?? null,
      authorizationUrl: process.env.OAUTH_AUTHORIZATION_URL ?? null,
      tokenUrl: process.env.OAUTH_TOKEN_URL ?? null,
      userinfoUrl: process.env.OAUTH_USERINFO_URL ?? null,
      allowAutoLinking: process.env.OAUTH_ALLOW_AUTO_LINKING === "true",
      // Group claims usually need an extra scope, e.g. "openid email profile groups".
      scopes: process.env.OAUTH_SCOPES?.trim() || null,
      // ── Group-based roles (env-configured provider) ─────────────────────────
      groupsClaim: process.env.OAUTH_GROUPS_CLAIM?.trim() || null,
      groupPrefix: process.env.OAUTH_GROUP_PREFIX?.trim() || null,
      roleMappingEnabled: process.env.OAUTH_ROLE_MAPPING === "true",
      adminGroup: process.env.OAUTH_ADMIN_GROUP?.trim() || null,
      operatorGroup: process.env.OAUTH_OPERATOR_GROUP?.trim() || null,
      userGroup: process.env.OAUTH_USER_GROUP?.trim() || null,
      viewerGroup: process.env.OAUTH_VIEWER_GROUP?.trim() || null,
      defaultRole: process.env.OAUTH_DEFAULT_ROLE?.trim() || null,
      syncGroups: process.env.OAUTH_SYNC_GROUPS === "true",
    },
    forwardAuthInternalUrl: process.env.FORWARD_AUTH_INTERNAL_URL ?? null,
  };

  /** Validates config at production startup, throwing on insecure defaults. Safe during build. */
  function validateProductionConfig() {
    if (runtime.isRuntimeProduction) {
      // Reading them forces validation, which throws on production defaults.
      void config.sessionSecret;
      // Short-circuits in OIDC-only mode.
      void config.adminUsername;
      void config.adminPassword;
    }
  }

  return { config, validateProductionConfig };
}

export const { config, validateProductionConfig } = readConfig();
