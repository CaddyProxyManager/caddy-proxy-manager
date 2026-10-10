/**
 * Sign-in and sign-up policy through the settings registry, not `config`, which reads
 * `process.env` once at load so a saved value would need a restart. Settings modules are imported
 * lazily, as http/public-url.ts does, and cached for the process.
 */
import { config } from "../config";

export type AuthPolicy = {
  disableLocalUsers: boolean;
  allowSelfRegistration: boolean;
  allowOauthRegistration: boolean;
  allowOauthRoleFromClaims: boolean;
  /** Build URLs from the request's Host header. */
  trustHost: boolean;
  rateLimit: { enabled: boolean; window: number; max: number };
};

/** For paths that run before a database is reachable. */
function fromEnvironment(): AuthPolicy {
  return {
    disableLocalUsers: config.auth.disableLocalUsers,
    allowSelfRegistration: config.auth.allowSelfRegistration,
    allowOauthRegistration: config.auth.allowOauthRegistration,
    allowOauthRoleFromClaims: config.auth.allowOauthRoleFromClaims,
    trustHost: process.env.AUTH_TRUST_HOST === "true",
    rateLimit: {
      enabled: process.env.AUTH_RATE_LIMIT_ENABLED !== "false",
      // `||`: Compose passes an unset variable as the empty string, which Number() reads as 0.
      window: Number(process.env.AUTH_RATE_LIMIT_WINDOW || 60),
      max: Number(process.env.AUTH_RATE_LIMIT_MAX || 5),
    },
  };
}

export async function authPolicy(): Promise<AuthPolicy> {
  try {
    const [registry, { resolveSetting }] = await Promise.all([
      import("../settings/registry"),
      import("../settings/resolve"),
    ]);

    const [
      disabled,
      selfRegistration,
      oauthRegistration,
      roleFromClaims,
      trustHost,
      rateLimitEnabled,
      rateLimitWindow,
      rateLimitMax,
    ] = await Promise.all([
      resolveSetting(registry.disableLocalUsers),
      resolveSetting(registry.allowSelfRegistration),
      resolveSetting(registry.allowOauthRegistration),
      resolveSetting(registry.allowOauthRoleFromClaims),
      resolveSetting(registry.trustHost),
      resolveSetting(registry.authRateLimitEnabled),
      resolveSetting(registry.authRateLimitWindow),
      resolveSetting(registry.authRateLimitMax),
    ]);

    return {
      disableLocalUsers: disabled.value,
      allowSelfRegistration: !disabled.value && selfRegistration.value,
      // Open by default in OIDC-only mode, where the IdP is the only way in; an explicit "no"
      // is still honoured.
      allowOauthRegistration:
        disabled.value && oauthRegistration.source === "default" ? true : oauthRegistration.value,
      allowOauthRoleFromClaims: roleFromClaims.value,
      trustHost: trustHost.value,
      rateLimit: {
        enabled: rateLimitEnabled.value,
        window: rateLimitWindow.value,
        max: rateLimitMax.value,
      },
    };
  } catch {
    return fromEnvironment();
  }
}

export async function localUsersDisabled(): Promise<boolean> {
  return (await authPolicy()).disableLocalUsers;
}

/** Whether /login/sign-up is offered; already false while local users are off. */
export async function selfRegistrationOpen(): Promise<boolean> {
  return (await authPolicy()).allowSelfRegistration;
}
