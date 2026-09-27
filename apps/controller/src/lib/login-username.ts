/**
 * The username the login page signs in with. Page-safe: the Users page and the username plugin
 * share it. CPM never makes one up - see ownEmailUsername in sign-in-names.ts.
 */
export const LOGIN_USERNAME_MIN_LENGTH = 3;
export const LOGIN_USERNAME_MAX_LENGTH = 255;

export function isValidLoginUsername(username: string): boolean {
  return (
    username.length >= LOGIN_USERNAME_MIN_LENGTH &&
    username.length <= LOGIN_USERNAME_MAX_LENGTH &&
    /^[a-zA-Z0-9_.@-]+$/.test(username)
  );
}

/** Better Auth lowercases what is typed and matches exactly, so a stored one must be lowercase. */
export function isUsableSignInUsername(username: string | null | undefined): username is string {
  return !!username && isValidLoginUsername(username) && username === username.toLowerCase();
}
