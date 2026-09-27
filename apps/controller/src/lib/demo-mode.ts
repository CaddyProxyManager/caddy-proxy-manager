/**
 * Nothing reaches a real Caddy. An env var, not a setting: a demo visitor must not switch it off
 * and configure a real server or DNS. Read per call so a test can flip it.
 */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE?.trim().toLowerCase() === "true";
}

/** The id ensureAdminUser always seeds the environment's administrator under. */
export const SEEDED_ADMIN_ID = 1;

/** Shared by every demo visitor, so it cannot be disabled, demoted or re-passworded. */
export function isDemoAdmin(userId: number): boolean {
  return isDemoMode() && userId === SEEDED_ADMIN_ID;
}
