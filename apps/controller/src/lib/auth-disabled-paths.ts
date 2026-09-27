/**
 * Answered 404: each skips the app's password policy, `users.passwordHash` or unlink guard, leaks
 * whether an account exists, is a guessing oracle, or hands out IdP tokens. Its own module so a
 * test can use it without the database. Resets go through /api/password-reset/* instead.
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
  // No codes by email or SMS: the mailbox a reset link opens is no second factor.
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
];
