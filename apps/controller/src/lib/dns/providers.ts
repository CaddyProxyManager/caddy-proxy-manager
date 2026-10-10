import { CADDY_DURATION_SEGMENT } from "../caddy/duration";
import type { AcmeDnsAccount, DnsChallengeDelegation } from "./challenge-delegation";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DnsProviderFieldType = "string" | "password" | "duration";

export type DnsProviderField = {
  /** The stored and REST field name, and the Caddy config key unless `caddyKey` says otherwise. */
  key: string;
  /** Caddy's name for the field where it differs from the one credentials are stored under. */
  caddyKey?: string;
  label: string;
  /** "password" fields are encrypted at rest; "duration" fields are validated as Caddy durations */
  type: DnsProviderFieldType;
  placeholder?: string;
  description?: string;
  required: boolean;
};

export type DnsProviderDefinition = {
  /** Caddy DNS module name (e.g. "cloudflare", "route53") */
  name: string;
  displayName: string;
  description?: string;
  docsUrl?: string;
  fields: DnsProviderField[];
  modulePath: string;
  /** Applied when the matching option field is left empty. */
  challengeDefaults?: DnsProviderChallengeDefaults;
};

/** Keys are the Caddy `challenges.dns` fields of the same name; values are Caddy durations. */
export type DnsProviderChallengeDefaults = {
  propagation_delay?: string;
  propagation_timeout?: string;
};

export type DnsProviderCredentials = {
  provider: string;
  credentials: Record<string, string>;
};

/** Names only: credential values stay write-only over REST. */
export type DnsProviderApiStatus = {
  providers: Record<string, { configuredFields: string[] }>;
  default: string | null;
  delegations: DnsChallengeDelegation[];
  /** Only the CNAME target, which is public in DNS anyway; the rest stays write-only. */
  acmeDnsAccounts: Record<string, { fulldomain: string }>;
};

export type LegacyCloudflareApiStatus = {
  hasApiToken: boolean;
  zoneId?: string;
  accountId?: string;
};

// ─── Registry ────────────────────────────────────────────────────────────────

/** Keys that tune the DNS challenge itself rather than the provider module. */
export const CHALLENGE_OPTION_KEYS = ["propagation_delay", "propagation_timeout"] as const;

/** Appended to every provider, so slow-propagation DNS can be worked around without raw config. */
export function challengeOptionFields(defaults?: DnsProviderChallengeDefaults): DnsProviderField[] {
  return [
    {
      key: "propagation_delay",
      label: "Propagation delay",
      type: "duration",
      required: false,
      placeholder: defaults?.propagation_delay ?? "e.g. 60s",
      description:
        "How long to wait before starting the DNS propagation checks, e.g. 60s or 5m." +
        (defaults?.propagation_delay
          ? ` Defaults to ${defaults.propagation_delay} for this provider.`
          : ""),
    },
    {
      key: "propagation_timeout",
      label: "Propagation timeout",
      type: "duration",
      required: false,
      placeholder: defaults?.propagation_timeout ?? "e.g. 2m",
      description:
        "Maximum time to wait for the challenge TXT record to propagate, e.g. 2m or 15m. Use -1 to disable the propagation check." +
        (defaults?.propagation_timeout
          ? ` Defaults to ${defaults.propagation_timeout} for this provider.`
          : ""),
    },
  ];
}

const BASE_DNS_PROVIDERS: DnsProviderDefinition[] = [
  {
    name: "cloudflare",
    displayName: "Cloudflare",
    description: "Cloudflare DNS API",
    docsUrl: "https://github.com/caddy-dns/cloudflare",
    modulePath: "github.com/caddy-dns/cloudflare",
    fields: [
      {
        key: "api_token",
        label: "API token",
        type: "password",
        required: true,
        placeholder: "Cloudflare API token with Zone:DNS:Edit permission",
      },
    ],
  },
  {
    name: "route53",
    displayName: "Amazon Route 53",
    description: "AWS Route 53 DNS API (supports IAM roles when fields are empty)",
    docsUrl: "https://github.com/caddy-dns/route53",
    modulePath: "github.com/caddy-dns/route53",
    fields: [
      {
        key: "access_key_id",
        label: "Access key ID",
        type: "string",
        required: false,
        placeholder: "AKIA…",
      },
      { key: "secret_access_key", label: "Secret access key", type: "password", required: false },
      {
        key: "region",
        label: "AWS region",
        type: "string",
        required: false,
        placeholder: "us-east-1",
      },
      {
        key: "hosted_zone_id",
        label: "Hosted zone ID",
        type: "string",
        required: false,
        placeholder: "Z1234567890",
        description: "Optional. Required only if you have multiple zones for the same domain.",
      },
    ],
  },
  {
    name: "digitalocean",
    displayName: "DigitalOcean",
    description: "DigitalOcean DNS API",
    docsUrl: "https://github.com/caddy-dns/digitalocean",
    modulePath: "github.com/caddy-dns/digitalocean",
    // Stored as api_token since the first release; libdns/digitalocean reads `auth_token`.
    fields: [
      {
        key: "api_token",
        caddyKey: "auth_token",
        label: "API token",
        type: "password",
        required: true,
      },
    ],
  },
  {
    name: "duckdns",
    displayName: "Duck DNS",
    description: "Duck DNS dynamic DNS service",
    docsUrl: "https://github.com/caddy-dns/duckdns",
    modulePath: "github.com/caddy-dns/duckdns",
    fields: [{ key: "api_token", label: "Token", type: "password", required: true }],
  },
  {
    name: "hetzner",
    displayName: "Hetzner",
    // v2 speaks the Cloud DNS API (zones in the Hetzner Console); the DNS Console API is retired.
    description: "Hetzner Cloud DNS API, for zones in the Hetzner Console",
    docsUrl: "https://github.com/caddy-dns/hetzner",
    modulePath: "github.com/caddy-dns/hetzner/v2",
    fields: [{ key: "api_token", label: "API token", type: "password", required: true }],
  },
  {
    name: "vultr",
    displayName: "Vultr",
    description: "Vultr DNS API",
    docsUrl: "https://github.com/caddy-dns/vultr",
    modulePath: "github.com/caddy-dns/vultr",
    fields: [{ key: "api_token", label: "API key", type: "password", required: true }],
  },
  {
    name: "porkbun",
    displayName: "Porkbun",
    description: "Porkbun DNS API",
    docsUrl: "https://github.com/caddy-dns/porkbun",
    modulePath: "github.com/caddy-dns/porkbun",
    fields: [
      { key: "api_key", label: "API key", type: "password", required: true },
      { key: "api_secret_key", label: "API secret key", type: "password", required: true },
    ],
  },
  {
    name: "godaddy",
    displayName: "GoDaddy",
    description: "GoDaddy DNS API",
    docsUrl: "https://github.com/caddy-dns/godaddy",
    modulePath: "github.com/caddy-dns/godaddy",
    fields: [
      {
        key: "api_token",
        label: "API key:secret",
        type: "password",
        required: true,
        placeholder: "key:secret",
        description: "Format: API_KEY:API_SECRET",
      },
    ],
  },
  {
    name: "namecheap",
    displayName: "Namecheap",
    description: "Namecheap DNS API",
    docsUrl: "https://github.com/caddy-dns/namecheap",
    modulePath: "github.com/caddy-dns/namecheap",
    fields: [
      { key: "api_key", label: "API key", type: "password", required: true },
      { key: "user", label: "Username", type: "string", required: true },
    ],
  },
  {
    name: "ovh",
    displayName: "OVH",
    description: "OVH DNS API",
    docsUrl: "https://github.com/caddy-dns/ovh",
    modulePath: "github.com/caddy-dns/ovh",
    fields: [
      { key: "endpoint", label: "Endpoint", type: "string", required: true, placeholder: "ovh-eu" },
      { key: "application_key", label: "Application key", type: "string", required: true },
      { key: "application_secret", label: "Application secret", type: "password", required: true },
      { key: "consumer_key", label: "Consumer key", type: "password", required: true },
    ],
  },
  {
    name: "ionos",
    displayName: "IONOS",
    description: "IONOS DNS API",
    docsUrl: "https://github.com/caddy-dns/ionos",
    modulePath: "github.com/caddy-dns/ionos",
    fields: [
      {
        key: "auth_api_token",
        label: "API token",
        type: "password",
        required: true,
        placeholder: "prefix.secret",
      },
    ],
  },
  {
    name: "linode",
    displayName: "Linode (Akamai)",
    description: "Linode/Akamai DNS API",
    docsUrl: "https://github.com/caddy-dns/linode",
    modulePath: "github.com/caddy-dns/linode",
    fields: [{ key: "api_token", label: "API token", type: "password", required: true }],
  },
  {
    name: "njalla",
    displayName: "Njalla",
    description: "Njalla DNS API",
    docsUrl: "https://github.com/caddy-dns/njalla",
    modulePath: "github.com/caddy-dns/njalla",
    fields: [{ key: "api_token", label: "API token", type: "password", required: true }],
  },
  {
    name: "spaceship",
    displayName: "Spaceship",
    description: "Spaceship DNS API",
    docsUrl: "https://github.com/caddy-dns/spaceship",
    modulePath: "github.com/caddy-dns/spaceship",
    fields: [
      { key: "api_key", label: "API key", type: "password", required: true },
      { key: "api_secret", label: "API secret", type: "password", required: true },
    ],
  },
  {
    name: "desec",
    displayName: "deSEC",
    description: "deSEC DNS API",
    docsUrl: "https://github.com/caddy-dns/desec",
    modulePath: "github.com/caddy-dns/desec",
    fields: [{ key: "token", label: "API token", type: "password", required: true }],
  },
  {
    name: "dynu",
    displayName: "Dynu",
    description: "Dynu DNS API",
    docsUrl: "https://github.com/caddy-dns/dynu",
    modulePath: "github.com/caddy-dns/dynu",
    fields: [{ key: "api_token", label: "API token", type: "password", required: true }],
  },
  {
    name: "acmedns",
    displayName: "acme-dns",
    description: "acme-dns delegated DNS-01 validation (dedicated ACME challenge records only)",
    docsUrl: "https://github.com/caddy-dns/acmedns",
    modulePath: "github.com/caddy-dns/acmedns",
    fields: [
      // Optional: per-domain accounts from Register replace the single one.
      { key: "username", label: "Username", type: "string", required: false },
      { key: "password", label: "Password", type: "password", required: false },
      { key: "subdomain", label: "Subdomain", type: "string", required: false },
      {
        key: "server_url",
        label: "Server URL",
        type: "string",
        required: false,
        placeholder: "https://auth.acme-dns.io",
      },
    ],
  },
  {
    name: "infomaniak",
    displayName: "Infomaniak",
    description: "Infomaniak DNS API",
    docsUrl: "https://github.com/caddy-dns/infomaniak",
    modulePath: "github.com/caddy-dns/infomaniak",
    fields: [{ key: "api_token", label: "API token", type: "password", required: true }],
  },
  {
    name: "inwx",
    displayName: "INWX",
    description: "INWX DNS API",
    docsUrl: "https://github.com/caddy-dns/inwx",
    modulePath: "github.com/caddy-dns/inwx",
    fields: [
      { key: "username", label: "Username", type: "string", required: true },
      { key: "password", label: "Password", type: "password", required: true },
      { key: "shared_secret", label: "2FA shared secret", type: "password", required: false },
      { key: "endpoint_url", label: "Endpoint URL", type: "string", required: false },
    ],
  },
  {
    name: "netcup",
    displayName: "netcup",
    description: "netcup CCP DNS API",
    docsUrl: "https://github.com/caddy-dns/netcup",
    modulePath: "github.com/caddy-dns/netcup",
    fields: [
      { key: "customer_number", label: "Customer number", type: "string", required: true },
      { key: "api_key", label: "API key", type: "password", required: true },
      { key: "api_password", label: "API password", type: "password", required: true },
    ],
    // Notoriously slow propagation:
    // https://github.com/caddy-dns/netcup#attention-slow-netcup-propagation-time
    challengeDefaults: { propagation_delay: "600s", propagation_timeout: "900s" },
  },
  {
    name: "cloudns",
    displayName: "ClouDNS",
    description: "ClouDNS DNS API",
    docsUrl: "https://github.com/caddy-dns/cloudns",
    modulePath: "github.com/caddy-dns/cloudns",
    fields: [
      {
        key: "auth_id",
        label: "Auth ID",
        type: "string",
        required: false,
        placeholder: "1234",
        description:
          "API user ID (created under API & Resellers). Required unless a sub-user ID is provided.",
      },
      {
        key: "sub_auth_id",
        label: "Sub-user ID",
        type: "string",
        required: false,
        description: "API sub-user ID. Required unless an API user ID is provided.",
      },
      {
        key: "auth_password",
        label: "API password",
        type: "password",
        required: true,
        description: "Password of the API user or sub-user.",
      },
    ],
  },
  {
    name: "rfc2136",
    displayName: "RFC2136 (BIND / TSIG)",
    description: "RFC 2136 dynamic DNS updates via a TSIG key (BIND 9 and compatible servers)",
    docsUrl: "https://github.com/caddy-dns/rfc2136",
    modulePath: "github.com/caddy-dns/rfc2136",
    fields: [
      {
        key: "key_name",
        label: "TSIG key name",
        type: "string",
        required: true,
        placeholder: "my-transfer-key",
        description: "Name of the TSIG key as defined on the DNS server.",
      },
      {
        key: "key_alg",
        label: "TSIG algorithm",
        type: "string",
        required: true,
        placeholder: "hmac-sha256",
        description: "HMAC algorithm of the TSIG key, e.g. hmac-sha256, hmac-sha512 or hmac-md5.",
      },
      {
        key: "key",
        label: "TSIG key secret",
        type: "password",
        required: true,
        description: "The base64 shared secret from the key statement, or from `tsig-keygen`.",
      },
      {
        key: "server",
        label: "DNS server",
        type: "string",
        required: true,
        placeholder: "1.2.3.4:53",
        description: "Authoritative server that accepts RFC 2136 dynamic updates, as host:port.",
      },
    ],
  },
];

export const DNS_PROVIDERS: DnsProviderDefinition[] = BASE_DNS_PROVIDERS.map((provider) => ({
  ...provider,
  fields: [...provider.fields, ...challengeOptionFields(provider.challengeDefaults)],
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DURATION_PATTERN = new RegExp(`^-1$|^[+-]?(?:${CADDY_DURATION_SEGMENT})+$`);

/** "-1" disables propagation checks. Unit-less numbers are refused: Caddy reads them as ns. */
export function isValidDnsDuration(value: string): boolean {
  return DURATION_PATTERN.test(value);
}

export function getProviderDefinition(name: string): DnsProviderDefinition | undefined {
  return DNS_PROVIDERS.find((p) => p.name === name);
}

/** Redacts every value, not just `password` fields, so a new credential field starts safe. */
export function redactDnsProviderSettingsForApi(settings: {
  providers: Record<string, Record<string, string>>;
  default: string | null;
  delegations?: DnsChallengeDelegation[];
  acmeDnsAccounts?: Record<string, AcmeDnsAccount>;
}): DnsProviderApiStatus {
  return {
    providers: Object.fromEntries(
      Object.entries(settings.providers).map(([provider, credentials]) => [
        provider,
        {
          configuredFields: Object.entries(credentials)
            .filter(([, value]) => typeof value === "string" && value.length > 0)
            .map(([key]) => key)
            .sort(),
        },
      ]),
    ),
    default: settings.default,
    delegations: (settings.delegations ?? []).map((delegation) => ({
      domain: delegation.domain,
      target: delegation.target ?? null,
      provider: delegation.provider ?? null,
    })),
    acmeDnsAccounts: Object.fromEntries(
      Object.entries(settings.acmeDnsAccounts ?? {}).map(([domain, account]) => [
        domain,
        { fulldomain: account.fulldomain },
      ]),
    ),
  };
}

export function redactLegacyCloudflareSettingsForApi(settings: {
  apiToken: string;
  zoneId?: string;
  accountId?: string;
}): LegacyCloudflareApiStatus {
  return {
    hasApiToken: settings.apiToken.length > 0,
    ...(settings.zoneId ? { zoneId: settings.zoneId } : {}),
    ...(settings.accountId ? { accountId: settings.accountId } : {}),
  };
}

// Crypto and challenge config live in dns/provider-credentials.ts: this file reaches the client.
