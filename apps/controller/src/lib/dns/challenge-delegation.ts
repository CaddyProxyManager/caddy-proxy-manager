/**
 * DNS-01 challenge delegation: `_acme-challenge.<name>` CNAMEd to a record a DNS provider can
 * write. certmagic writes the TXT at `override_domain` without following the CNAME, and the field
 * covers every subject of an automation policy, so policies are split by delegation here.
 * No database, crypto or network, so the Settings screen can import it.
 */

/** Stored in the `dns_provider` blob. At least one of `target` and `provider` is set. */
export type DnsChallengeDelegation = {
  /** A suffix: it covers itself and every name under it. */
  domain: string;
  /** `challenges.dns.override_domain`: where `_acme-challenge.<name>` points. */
  target?: string | null;
  /** A configured provider; absent means the certificate's or the default one. */
  provider?: string | null;
};

/** The acme-dns module's per-domain account, in its own JSON field names. */
export type AcmeDnsAccount = {
  username: string;
  /** Encrypted at rest. */
  password: string;
  subdomain: string;
  fulldomain: string;
  server_url: string;
};

export const ACME_CHALLENGE_LABEL = "_acme-challenge";
export const ACMEDNS_PROVIDER = "acmedns";
export const MAX_DNS_DELEGATIONS = 256;

// Underscores are allowed: a delegation target is often itself an `_acme-challenge` name.
const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/;

/** Lowercased, without a trailing dot; wildcards and anything Caddy's replacer would read fail. */
export function normalizeDnsName(value: string): string | null {
  const name = value.trim().toLowerCase().replace(/\.$/, "");
  return DNS_NAME.test(name) ? name : null;
}

/** The name whose `_acme-challenge` record answers for a subject: `*.x` answers at `x`. */
export function challengeBaseName(subject: string): string {
  return subject.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

export function challengeRecordName(domain: string): string {
  return `${ACME_CHALLENGE_LABEL}.${challengeBaseName(domain)}`;
}

function covers(suffix: string, name: string): boolean {
  return name === suffix || name.endsWith(`.${suffix}`);
}

/** Longest suffix wins, so a delegation for `a.example.com` beats one for `example.com`. */
export function longestSuffixMatch<T>(name: string, entries: Iterable<[string, T]>): T | null {
  let best: { length: number; value: T } | null = null;
  for (const [suffix, value] of entries) {
    const normalized = challengeBaseName(suffix);
    if (covers(normalized, name) && (!best || normalized.length > best.length)) {
      best = { length: normalized.length, value };
    }
  }
  return best?.value ?? null;
}

export function matchDelegation(
  subject: string,
  delegations: readonly DnsChallengeDelegation[] | undefined,
): DnsChallengeDelegation | null {
  if (!delegations || delegations.length === 0) return null;
  return longestSuffixMatch(
    challengeBaseName(subject),
    delegations.map((delegation) => [delegation.domain, delegation] as [string, typeof delegation]),
  );
}

/** The CNAME a delegation needs, or null when it only picks a provider. */
export function expectedDelegationTarget(
  delegation: DnsChallengeDelegation,
  accounts: Record<string, Pick<AcmeDnsAccount, "fulldomain">> | undefined,
): string | null {
  if (delegation.target) return delegation.target;
  if (delegation.provider === ACMEDNS_PROVIDER) {
    const account = accounts?.[challengeBaseName(delegation.domain)];
    return account?.fulldomain ?? null;
  }
  return null;
}

function hasSingleAcmeDnsAccount(credentials: Record<string, string> | undefined): boolean {
  return Boolean(
    credentials?.username &&
      credentials.password &&
      credentials.subdomain &&
      credentials.server_url,
  );
}

export type DnsChallengePartition = {
  subjects: string[];
  /** Null: no DNS-01 for these subjects. */
  provider: string | null;
  target: string | null;
  /** The acme-dns module's `config` map, keyed by the name it looks accounts up by. */
  acmeDnsConfig: Record<string, AcmeDnsAccount> | null;
};

export type DnsChallengeSettings = {
  providers: Record<string, Record<string, string>>;
  delegations?: DnsChallengeDelegation[];
  acmeDnsAccounts?: Record<string, AcmeDnsAccount>;
};

/**
 * Splits one policy's subjects by how their challenge is answered. With no delegations and no
 * acme-dns accounts this is one partition on `baseProvider`, the config it replaced.
 */
export function partitionDnsChallenges(
  subjects: readonly string[],
  settings: DnsChallengeSettings | null | undefined,
  baseProvider: string | null,
  providerUsable: (provider: string) => boolean,
  warn: (message: string) => void,
): DnsChallengePartition[] {
  const partitions = new Map<string, DnsChallengePartition>();
  const accounts = Object.entries(settings?.acmeDnsAccounts ?? {});

  const add = (
    subject: string,
    provider: string | null,
    target: string | null,
    account?: [string, AcmeDnsAccount],
  ) => {
    const key = `${provider ?? ""}\n${target ?? ""}`;
    let partition = partitions.get(key);
    if (!partition) {
      partition = { subjects: [], provider, target, acmeDnsConfig: null };
      partitions.set(key, partition);
    }
    partition.subjects.push(subject);
    if (account) {
      partition.acmeDnsConfig ??= {};
      partition.acmeDnsConfig[account[0]] = account[1];
    }
  };

  for (const subject of subjects) {
    const delegation = matchDelegation(subject, settings?.delegations);
    const provider = delegation?.provider || baseProvider;
    const target = delegation?.target || null;

    if (!provider) {
      add(subject, null, null);
      continue;
    }
    const credentials = settings?.providers[provider];
    if (!credentials || !providerUsable(provider)) {
      if (delegation) {
        warn(
          `Skipping the ACME DNS-01 challenge for "${subject}": its challenge delegation ` +
            `(${delegation.domain}) has no usable DNS provider "${provider}".`,
        );
      }
      add(subject, null, null);
      continue;
    }

    if (provider !== ACMEDNS_PROVIDER || accounts.length === 0) {
      if (provider === ACMEDNS_PROVIDER && !hasSingleAcmeDnsAccount(credentials)) {
        warn(`Skipping the ACME DNS-01 challenge for "${subject}": no acme-dns account covers it.`);
        add(subject, null, null);
        continue;
      }
      add(subject, provider, target);
      continue;
    }

    // The module looks an account up by the record name minus `_acme-challenge.`.
    const lookup = target
      ? challengeBaseName(target).replace(new RegExp(`^${ACME_CHALLENGE_LABEL}\\.`), "")
      : challengeBaseName(subject);
    // A target is an account's fulldomain, not a name any account is keyed by, so the account
    // registered for the delegation's domain answers for it.
    const account =
      longestSuffixMatch(lookup, accounts) ??
      (target && delegation
        ? longestSuffixMatch(challengeBaseName(delegation.domain), accounts)
        : null) ??
      (hasSingleAcmeDnsAccount(credentials)
        ? {
            username: credentials.username,
            password: credentials.password,
            subdomain: credentials.subdomain,
            fulldomain: credentials.fulldomain ?? "",
            server_url: credentials.server_url,
          }
        : null);
    if (!account) {
      warn(`Skipping the ACME DNS-01 challenge for "${subject}": no acme-dns account covers it.`);
      add(subject, null, null);
      continue;
    }
    add(subject, provider, target, [lookup, account]);
  }

  return [...partitions.values()];
}

/** True when some provider could answer a wildcard's challenge. */
export function hasDnsChallengeFor(
  subject: string,
  settings: (DnsChallengeSettings & { default: string | null }) | null | undefined,
): boolean {
  if (!settings) return false;
  const delegation = matchDelegation(subject, settings.delegations);
  const provider = delegation?.provider || settings.default;
  return Boolean(provider && settings.providers[provider]);
}
