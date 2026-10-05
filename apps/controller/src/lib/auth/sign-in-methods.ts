/** How an account last signed in. No server imports: the users list renders them. */
export const SIGN_IN_METHODS = ["password", "passkey", "oidc", "ldap"] as const;

export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export function isSignInMethod(value: unknown): value is SignInMethod {
  return (SIGN_IN_METHODS as readonly unknown[]).includes(value);
}
