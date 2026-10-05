/**
 * Looks up each delegation's `_acme-challenge` CNAME from the controller. A warning only: the
 * controller's resolver may see a split-horizon view, and the CA's is the one that counts.
 */

import { Resolver } from "node:dns/promises";
import {
  type AcmeDnsAccount,
  type DnsChallengeDelegation,
  challengeRecordName,
  expectedDelegationTarget,
} from "./challenge-delegation";

const LOOKUP_TIMEOUT_MS = 5_000;

export type DelegationCheck = {
  domain: string;
  record: string;
  expected: string | null;
  found: string[];
  /** `none`: the delegation only picks a provider, so there is no CNAME to look for. */
  status: "ok" | "missing" | "mismatch" | "none";
};

async function resolveCname(name: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
  return await resolver.resolveCname(name).catch(() => [] as string[]);
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");
}

export async function checkDelegations(
  delegations: readonly DnsChallengeDelegation[],
  accounts: Record<string, Pick<AcmeDnsAccount, "fulldomain">> | undefined,
  // Test seam; real callers pass nothing.
  lookup: (name: string) => Promise<string[]> = resolveCname,
): Promise<DelegationCheck[]> {
  return await Promise.all(
    delegations.map(async (delegation): Promise<DelegationCheck> => {
      const record = challengeRecordName(delegation.domain);
      const expected = expectedDelegationTarget(delegation, accounts);
      if (!expected)
        return { domain: delegation.domain, record, expected, found: [], status: "none" };
      const found = await lookup(record);
      const status =
        found.length === 0
          ? "missing"
          : found.some((name) => sameName(name, expected))
            ? "ok"
            : "mismatch";
      return { domain: delegation.domain, record, expected, found, status };
    }),
  );
}
