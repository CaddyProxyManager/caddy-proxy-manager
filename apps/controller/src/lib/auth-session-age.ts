/**
 * A sign-in this recent stands in for re-auth where there is no password to ask for. Short: a
 * borrowed or stolen session is usually an old one.
 */
export const FRESH_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

export function isFreshSession(session: { createdAt: Date } | null, now = Date.now()): boolean {
  return !!session && now - session.createdAt.getTime() <= FRESH_SESSION_MAX_AGE_MS;
}
