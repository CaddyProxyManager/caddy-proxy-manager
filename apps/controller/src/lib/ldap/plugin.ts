/**
 * `POST /sign-in/ldap`: a username and password checked against a directory. Its own plugin rather
 * than a community one, for the escaping, the error hygiene and config that lives in the database.
 *
 * With no `directoryId` it is the login form's transparent fallback: a local account is tried
 * first, then the one enabled directory. Either way the answer to anything wrong is the same
 * INVALID_USERNAME_OR_PASSWORD the username plugin gives.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, type createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { parseUserOutput } from "better-auth/db";
import { isValidLoginUsername } from "../login-username";
import { LDAP_SIGN_IN_PATH } from "../auth-sign-in-paths";
import { isAcceptableLdapPassword, isAcceptableLdapUsername } from "./client";
import { resolveSignInDirectory, signInWithDirectory } from "./sign-in";

type AfterHook = {
  matcher: (ctx: { path?: string }) => boolean;
  handler: ReturnType<typeof createAuthMiddleware>;
};

export type LdapPluginOptions = {
  /** The twoFactor plugin's after-hook, run for this path too so enrolled users get the code step. */
  twoFactorAfterHook: AfterHook["handler"] | null;
  localUsersEnabled: boolean;
  allowRegistration: boolean;
};

function refuse(): never {
  throw new APIError("UNAUTHORIZED", {
    message: "Invalid username or password",
    code: "INVALID_USERNAME_OR_PASSWORD",
  });
}

/** The twoFactor plugin's after-hook for credential sign-ins, found by what it matches. */
export function findTwoFactorAfterHook(plugin: unknown): AfterHook["handler"] | null {
  const hooks = (plugin as { hooks?: { after?: AfterHook[] } }).hooks?.after ?? [];
  const hook = hooks.find((candidate) => {
    try {
      return candidate.matcher({ path: "/sign-in/username" });
    } catch {
      return false;
    }
  });
  return hook?.handler ?? null;
}

export function ldapSignIn(options: LdapPluginOptions): BetterAuthPlugin {
  return {
    id: "cpm-ldap",
    endpoints: {
      signInLdap: createAuthEndpoint(LDAP_SIGN_IN_PATH, { method: "POST" }, async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const directoryId =
          typeof body.directoryId === "string" && body.directoryId ? body.directoryId : null;
        const rememberMe = body.rememberMe !== false;

        // Before any lookup or bind: see isAcceptableLdapPassword.
        if (!isAcceptableLdapUsername(username) || !isAcceptableLdapPassword(password)) refuse();

        let userId: number | null = null;
        const adapter = ctx.context.internalAdapter;

        // Local first, as /sign-in/username would, so the fallback never shadows a local account.
        if (!directoryId && options.localUsersEnabled && isValidLoginUsername(username)) {
          const local = await ctx.context.adapter.findOne<{ id: string }>({
            model: "user",
            where: [{ field: "username", value: username.toLowerCase() }],
          });
          if (!local) {
            // The username plugin's timing for an unknown name.
            await ctx.context.password.hash(password);
          } else {
            const credential = await adapter.findCredentialAccount(local.id);
            if (
              credential?.password &&
              (await ctx.context.password.verify({ hash: credential.password, password }))
            ) {
              userId = Number(local.id);
            }
          }
        }

        if (userId === null) {
          const directory = await resolveSignInDirectory(directoryId);
          if (!directory) refuse();
          userId = await signInWithDirectory(
            adapter,
            directory,
            username,
            password,
            options.allowRegistration,
          );
        }
        if (userId === null) refuse();

        const user = await adapter.findUserById(String(userId));
        if (!user) refuse();
        // Fails closed should a Better Auth upgrade move the hook: no code step, no sign-in.
        if (
          !options.twoFactorAfterHook &&
          (user as { twoFactorEnabled?: boolean }).twoFactorEnabled
        ) {
          console.error("[ldap] The two-factor hook was not found; refusing a 2FA account");
          refuse();
        }
        // The session hook refuses a disabled account with the same 401.
        const session = await adapter.createSession(user.id, !rememberMe);
        if (!session) refuse();
        await setSessionCookie(ctx, { session, user }, !rememberMe);
        return ctx.json({
          redirect: false,
          token: session.token,
          user: parseUserOutput(ctx.context.options, user),
        });
      }),
    },
    hooks: {
      after: options.twoFactorAfterHook
        ? [
            {
              matcher: (context) => context.path === LDAP_SIGN_IN_PATH,
              handler: options.twoFactorAfterHook,
            },
          ]
        : [],
    },
  } satisfies BetterAuthPlugin;
}
