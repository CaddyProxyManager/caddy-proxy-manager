import { createHash } from "node:crypto";
import {
  accountKey,
  registerAccountFailure,
  registerFailedAttempt,
  reserveAccountAttempt,
  reserveAttempt,
  resetAccountFailures,
  resetAttempts,
} from "./rate-limit";

/** Ended by the first call to any of these. */
export type PortalLoginAttempt = {
  /** Counts against the client, the (account, client) pair and the account. */
  fail(): Promise<void>;
  succeed(): void;
  /** Ends it uncounted, e.g. when checking it threw. */
  release(): void;
};

/** Failures from one client against one account, so signing in to its own account elsewhere cannot clear them. */
function accountIpKey(account: string, ip: string): string {
  // Hashed: a username is client-chosen, and every key should have one size.
  const hashed = createHash("sha256").update(account, "utf8").digest("base64url");
  return `portal-account-ip:${hashed}:${ip}`;
}

/**
 * Admits a portal login attempt, or null once any limit is reached. Attempts still being checked
 * count towards every limit, so concurrent requests get no more guesses than sequential ones.
 */
export async function beginPortalLoginAttempt(
  username: string,
  ip: string,
): Promise<PortalLoginAttempt | null> {
  const account = accountKey(username);
  const pairKey = accountIpKey(account, ip);

  const releases: Array<() => void> = [];
  const releaseAll = () => {
    for (const release of releases) release();
  };
  for (const key of [ip, pairKey]) {
    const release = await reserveAttempt(key);
    if (!release) {
      releaseAll();
      return null;
    }
    releases.push(release);
  }
  const accountRelease = reserveAccountAttempt(account);
  if (!accountRelease) {
    releaseAll();
    return null;
  }
  releases.push(accountRelease);

  let ended = false;
  const claim = () => {
    if (ended) return false;
    ended = true;
    return true;
  };
  return {
    async fail() {
      if (!claim()) return;
      // Counted before the places are given back, so no request slips into the gap.
      try {
        await registerFailedAttempt(ip);
        await registerFailedAttempt(pairKey);
        registerAccountFailure(account);
      } finally {
        releaseAll();
      }
    },
    succeed() {
      if (!claim()) return;
      resetAttempts(ip);
      resetAttempts(pairKey);
      resetAccountFailures(account);
      releaseAll();
    },
    release() {
      if (claim()) releaseAll();
    },
  };
}
