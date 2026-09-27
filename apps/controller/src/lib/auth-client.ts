import { createAuthClient } from "better-auth/react";
import type { BetterAuthClientPlugin } from "better-auth/client";
import { twoFactorClient, usernameClient } from "better-auth/client/plugins";

// Cast via unknown because better-auth's usernameClient $InferServerPlugin requires
// `email: string` while BetterAuthClientPlugin accepts an optional email field.
const usernamePlugin = usernameClient() as unknown as BetterAuthClientPlugin;

// No genericOAuthClient: since better-auth 1.7 each provider is a social one, so call sites use
// `signIn.social({ provider })`. No redirect option: the sign-in form shows the code step itself
// on `twoFactorRedirect`.
export const authClient = createAuthClient({
  plugins: [usernamePlugin, twoFactorClient()],
});
