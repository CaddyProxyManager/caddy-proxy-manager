/**
 * Whether each directory answers, for Needs attention and the sign-in overview. Each check is a
 * network round trip, so one is reused for a few minutes; a slow one keeps running past its
 * caller's budget and is ready for the next.
 */
import type { LdapDirectory } from "../models/ldap-directories";

const LDAP_CHECK_TTL_MS = 5 * 60_000;

export type LdapCheck = { at: number; failure: string | null };

const checks = new Map<string, LdapCheck>();
const running = new Map<string, Promise<void>>();

/** Test seam. */
export function resetLdapChecksForTests(): void {
  checks.clear();
  running.clear();
}

/** The latest result per directory id; a check still running is absent. */
export async function checkLdapDirectories(
  directories: LdapDirectory[],
  now: number = Date.now(),
): Promise<Map<string, LdapCheck>> {
  const { testLdapConnection } = await import("./client");
  await Promise.all(
    directories.map((directory) => {
      const cached = checks.get(directory.id);
      if (cached && now - cached.at < LDAP_CHECK_TTL_MS) return Promise.resolve();
      let pending = running.get(directory.id);
      if (!pending) {
        pending = testLdapConnection(directory)
          .then((result) => {
            checks.set(directory.id, {
              at: Date.now(),
              failure: result.ok ? null : result.stage,
            });
          })
          .catch(() => {
            checks.set(directory.id, { at: Date.now(), failure: "connect" });
          })
          .finally(() => running.delete(directory.id));
        running.set(directory.id, pending);
      }
      return pending;
    }),
  );
  return new Map(
    directories.flatMap((directory) => {
      const check = checks.get(directory.id);
      return check ? [[directory.id, check] as const] : [];
    }),
  );
}
