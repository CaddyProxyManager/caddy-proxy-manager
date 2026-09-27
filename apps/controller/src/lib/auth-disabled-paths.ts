/**
 * Answered 404: each skips the app's password policy, `users.passwordHash` or unlink guard, leaks
 * whether an account exists, is a guessing oracle, or hands out IdP tokens. Its own module so a
 * test can use it without the database.
 */
export const DISABLED_AUTH_PATHS = [
  "/change-password",
  "/request-password-reset",
  "/reset-password",
  "/verify-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/delete-user/callback",
  "/unlink-account",
  "/is-username-available",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  // CPM sends no email or SMS codes.
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
];
