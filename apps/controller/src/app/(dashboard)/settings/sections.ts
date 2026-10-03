/**
 * Every settings page in nav order, and its blocks. A block keeps the id of the page it once was,
 * so anchors, catalog keys and staged-change labels survived the merge. One list for the sidebar,
 * the page and the command palette, so none of them can disagree.
 */

import {
  BarChart2,
  Cloud,
  Cpu,
  KeyRound,
  Mail,
  MapPin,
  MonitorSmartphone,
  Package,
  Server,
  Settings2,
  ShieldBan,
  UserCheck,
  Waypoints,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { useTranslations } from "next-intl";

/** `id` is the anchor, the `settings.blocks.*` key, and where legacy links redirect. */
export type SettingsBlock = {
  id: string;
  name: string;
  desc: string;
  /**
   * Variables governing the whole block, shown beside its heading. Only ones that set a value
   * this block shows: a near-miss sends someone to a screen that cannot change it.
   */
  env?: readonly string[];
  /** Searchable but not shown, e.g. the members of a family whose prefix is in `env`. */
  envSearch?: readonly string[];
};

export type SettingItem = {
  id: string;
  name: string;
  desc: string;
  icon: LucideIcon;
  blocks: readonly SettingsBlock[];
};

export type SettingsGroup = {
  id: string;
  label: string;
  items: SettingItem[];
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "system",
    label: "System",
    items: [
      {
        id: "general",
        name: "General",
        desc: "Domain, ACME contact, updates, branding and avatars",
        icon: Settings2,
        blocks: [
          { id: "general", name: "General", desc: "Primary domain and ACME contact email" },
          {
            id: "acme",
            name: "ACME Server",
            desc: "Custom ACME directory URL for internal CAs",
            envSearch: ["ACME_CA_ROOT_DIR"],
          },
          {
            id: "updates",
            name: "Updates",
            desc: "Whether to check the registry for a newer release, and which one",
            envSearch: ["UPDATE_CHECK_ENABLED", "UPDATE_IMAGE_REPOSITORY"],
          },
          { id: "branding", name: "Branding", desc: "The favicon browsers show for this instance" },
          {
            id: "instance",
            name: "Instance",
            desc: "Names this instance and the address it is reached at",
            envSearch: ["APP_NAME", "BASE_URL"],
          },
          {
            id: "avatars",
            name: "User Avatars",
            desc: "Gravatar fallback for users without an icon",
            envSearch: ["AVATAR_GRAVATAR"],
          },
        ],
      },
      {
        id: "responses",
        name: "Responses",
        desc: "What Caddy answers for an unknown host, and when a host fails",
        icon: Server,
        blocks: [
          {
            id: "default-response",
            name: "Default Response",
            desc: "Handle requests for unknown hosts and direct IP access",
          },
          {
            id: "error-pages",
            name: "Error Pages",
            desc: "Global custom error responses (fallback for all hosts)",
          },
        ],
      },
      {
        id: "caddy-build",
        name: "Caddy Build",
        desc: "Which plugins the Caddy image is compiled with",
        icon: Package,
        blocks: [
          {
            id: "caddy-build",
            name: "Caddy Build",
            desc: "Which plugins the Caddy image is compiled with",
            env: ["CADDY_BUILD_TIMEOUT"],
          },
          {
            id: "global-caddy-config",
            name: "Global Caddyfile",
            desc: "Raw Caddy configuration added to every agent's config",
          },
          {
            id: "http-cache",
            name: "HTTP Cache",
            desc: "Where the Caddy cache keeps entries, and which CDN it purges",
          },
        ],
      },
      {
        id: "dashboard",
        name: "Dashboard Host",
        desc: "Serve this dashboard through Caddy, on a domain of its own",
        icon: MonitorSmartphone,
        blocks: [
          {
            id: "dashboard",
            name: "Dashboard Host",
            desc: "Serve this dashboard through Caddy, on a domain of its own",
            envSearch: ["DASHBOARD_DOMAIN"],
          },
        ],
      },
      {
        id: "agent",
        name: "Agent",
        desc: "The service that recreates and rebuilds the Caddy container",
        icon: Cpu,
        blocks: [
          {
            id: "agent",
            name: "Agent",
            desc: "The service that recreates and rebuilds the Caddy container",
            env: ["CONTROLLER_URL", "AGENT_MODE", "PAIRING_CODE", "CADDY_API_URL"],
            envSearch: ["CADDY_MONITOR_ENABLED"],
          },
        ],
      },
      {
        id: "email",
        name: "Email",
        desc: "The SMTP server resets, invitations and notifications are sent through",
        icon: Mail,
        blocks: [
          {
            id: "email",
            name: "SMTP Server",
            desc: "The server this instance sends mail through, and the address it sends as",
            envSearch: [
              "SMTP_ENABLED",
              "SMTP_HOST",
              "SMTP_PORT",
              "SMTP_SECURITY",
              "SMTP_USERNAME",
              "SMTP_PASSWORD",
              "SMTP_FROM",
            ],
          },
          {
            // Was "Certificate Alerts"; the id stays, so anchors and links still land here.
            id: "certificate-alerts",
            name: "Notifications",
            desc: "What the administrators are emailed about, and who else is",
            envSearch: [
              "CERTIFICATE_EXPIRY_ALERT_DAYS",
              "EMAIL_ALERT_RECIPIENTS",
              "NOTIFY_ACCOUNT_DISABLED",
              "NOTIFY_ADMIN_LOCKED",
              "NOTIFY_ADMIN_ADDED",
              "NOTIFY_AGENT_OFFLINE",
              "NOTIFY_AGENT_OFFLINE_MINUTES",
              "NOTIFY_UPSTREAM_ERRORS",
              "NOTIFY_UPSTREAM_ERROR_COUNT",
              "NOTIFY_UPSTREAM_ERROR_MINUTES",
              "NOTIFY_CADDY_APPLY",
              "NOTIFY_AGENT_PROBLEMS",
              "NOTIFY_GEOIP_FAILED",
              "NOTIFY_CRS_PLUGIN_DISABLED",
              "NOTIFY_UPDATE_AVAILABLE",
            ],
          },
        ],
      },
    ],
  },
  {
    id: "networking",
    label: "Networking",
    items: [
      {
        id: "dns",
        name: "DNS",
        desc: "Provider credentials, challenge resolvers and upstream pinning",
        icon: Cloud,
        blocks: [
          {
            id: "dns-providers",
            name: "DNS Providers",
            desc: "Provider credentials for ACME DNS-01",
          },
          {
            id: "dns-resolvers",
            name: "DNS Resolvers",
            desc: "Custom resolvers for challenge verification",
          },
          {
            id: "upstream-dns",
            name: "Upstream DNS Pinning",
            desc: "Pin upstream IPs at config-apply time",
          },
        ],
      },
      {
        id: "network",
        name: "Network",
        desc: "Trusted proxies, HTTP versions, compression, and the tailnet hosts are served on",
        icon: Waypoints,
        blocks: [
          {
            id: "trusted-proxies",
            name: "Trusted Proxies",
            desc: "Resolve real client IP behind an upstream proxy",
          },
          {
            id: "http-protocols",
            name: "HTTP Versions",
            desc: "Turn HTTP/2 or HTTP/3 off for every host",
          },
          {
            id: "compression",
            name: "Compression",
            desc: "Compress text responses with zstd or gzip",
          },
          {
            id: "tailscale",
            name: "Tailscale",
            desc: "Node defaults for hosts served on, or reached over, your tailnet",
            envSearch: ["TS_AUTHKEY"],
          },
        ],
      },
    ],
  },
  {
    id: "security",
    label: "Security",
    items: [
      {
        id: "authentication",
        name: "Authentication",
        desc: "How people sign in to this dashboard",
        icon: KeyRound,
        blocks: [
          {
            id: "oauth",
            name: "OAuth Providers",
            desc: "OAuth/OIDC SSO providers",
            // Nineteen tokens would drown the heading, so only the prefix is shown.
            env: ["OAUTH_*"],
            envSearch: [
              "OAUTH_ENABLED",
              "OAUTH_PROVIDER_NAME",
              "OAUTH_ISSUER",
              "OAUTH_CLIENT_ID",
              "OAUTH_CLIENT_SECRET",
              "OAUTH_AUTHORIZATION_URL",
              "OAUTH_TOKEN_URL",
              "OAUTH_USERINFO_URL",
              "OAUTH_SCOPES",
              "OAUTH_ALLOW_AUTO_LINKING",
              "OAUTH_DEFAULT_ROLE",
              "OAUTH_ROLE_MAPPING",
              "OAUTH_SYNC_GROUPS",
              "OAUTH_GROUPS_CLAIM",
              "OAUTH_GROUP_PREFIX",
              "OAUTH_ADMIN_GROUP",
              "OAUTH_OPERATOR_GROUP",
              "OAUTH_USER_GROUP",
              "OAUTH_VIEWER_GROUP",
            ],
          },
          {
            id: "ldap",
            name: "Directories (LDAP)",
            desc: "Sign in with an LDAP or Active Directory account",
          },
          {
            id: "sign-in",
            name: "Sign-in",
            desc: "Who may sign in or sign up, and how hard the door is to knock on",
            envSearch: [
              "AUTH_ALLOW_SELF_REGISTRATION",
              "AUTH_ALLOW_OAUTH_REGISTRATION",
              "AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS",
              "AUTH_DISABLE_LOCAL_USERS",
              "AUTH_TRUST_HOST",
              "AUTH_RATE_LIMIT_ENABLED",
              "AUTH_RATE_LIMIT_WINDOW",
              "AUTH_RATE_LIMIT_MAX",
              "LOGIN_MAX_ATTEMPTS",
              "LOGIN_WINDOW_MS",
              "LOGIN_BLOCK_MS",
              "ACCOUNT_LOCK_ENABLED",
              "ACCOUNT_LOCK_FREE_FAILURES",
              "ACCOUNT_LOCK_BASE_DELAY_MS",
              "ACCOUNT_LOCK_MAX_DELAY_MS",
              "ACCOUNT_LOCK_DISABLE_ENABLED",
              "ACCOUNT_LOCK_DISABLE_AFTER",
            ],
          },
          {
            id: "captcha",
            name: "CAPTCHA",
            desc: "A challenge to solve before the password is asked for",
          },
          {
            id: "two-factor",
            name: "Two-factor Sign-in",
            desc: "Require administrators to use an authenticator app",
          },
          {
            id: "password-policy",
            name: "Password Policy",
            desc: "Migrate users off older password hashes",
            envSearch: ["AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH"],
          },
        ],
      },
      {
        id: "forward-auth",
        name: "Forward Auth",
        desc: "Defaults a new proxy host inherits for an external authenticator",
        icon: UserCheck,
        blocks: [
          {
            id: "authentik",
            name: "Authentik Defaults",
            desc: "Forward-auth defaults for new proxy hosts",
            env: ["FORWARD_AUTH_INTERNAL_URL"],
          },
          {
            id: "forward-auth",
            name: "Forward Auth Defaults",
            desc: "Defaults for hosts authenticating through an external auth server",
            envSearch: ["FORWARD_AUTH_ALLOWED_PORTS"],
          },
        ],
      },
      {
        id: "geo",
        name: "Geo-blocking",
        desc: "Country lookups, and the default rules every host merges with",
        icon: MapPin,
        blocks: [
          {
            id: "geoip",
            name: "GeoIP Databases",
            desc: "MaxMind subscription and whether country lookups run at all",
            envSearch: [
              "GEOIP_ENABLED",
              "GEOIPUPDATE_ACCOUNT_ID",
              "GEOIPUPDATE_LICENSE_KEY",
              "GEOIP_UPDATE_INTERVAL_HOURS",
            ],
          },
          {
            id: "geoblock",
            name: "Global Geoblocking",
            desc: "Default geoblock rules across all hosts",
          },
        ],
      },
      {
        id: "crowdsec",
        name: "CrowdSec",
        desc: "Refuse addresses your CrowdSec Local API has decided to block",
        icon: ShieldBan,
        blocks: [
          {
            id: "crowdsec",
            name: "CrowdSec",
            desc: "The Local API and bouncer key every host checks clients against",
          },
        ],
      },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    items: [
      {
        id: "observability",
        name: "Observability",
        desc: "Analytics collection, the metrics endpoint and the access log",
        icon: BarChart2,
        blocks: [
          {
            id: "analytics",
            name: "Analytics",
            desc: "Traffic and WAF event collection, and the ClickHouse it writes to",
            envSearch: [
              "ANALYTICS_ENABLED",
              "CLICKHOUSE_URL",
              "CLICKHOUSE_USER",
              "CLICKHOUSE_PASSWORD",
              "CLICKHOUSE_DB",
              "CLICKHOUSE_RETENTION_DAYS",
            ],
          },
          { id: "metrics", name: "Metrics & Monitoring", desc: "Prometheus metrics endpoint" },
          { id: "logging", name: "Access Logging", desc: "HTTP access log for proxied requests" },
        ],
      },
    ],
  },
];

export const SETTINGS_ITEMS: SettingItem[] = SETTINGS_GROUPS.flatMap((group) => group.items);

export function findSettingsItem(id: string): SettingItem | undefined {
  return SETTINGS_ITEMS.find((item) => item.id === id);
}

export function groupForSection(id: string): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find((group) => group.items.some((item) => item.id === id));
}

export const SETTINGS_BLOCKS: readonly SettingsBlock[] = SETTINGS_ITEMS.flatMap(
  (item) => item.blocks,
);

/** Block ids that were once routes, so docs links and bookmarks redirect to the anchor. */
export const LEGACY_SECTION_PAGES: ReadonlyMap<string, { page: string; anchor: string }> = new Map(
  SETTINGS_ITEMS.flatMap((item) =>
    item.blocks
      .filter((block) => block.id !== item.id)
      .map((block) => [block.id, { page: item.id, anchor: block.id }] as const),
  ),
);

/** Callers link through this so none needs updating when a block moves page. */
export function settingsHref(id: string): string {
  const legacy = LEGACY_SECTION_PAGES.get(id);
  return legacy ? `/settings/${legacy.page}#${legacy.anchor}` : `/settings/${id}`;
}

// ─── Messages ────────────────────────────────────────────────────────────────

/*
 * Screens render the catalog entries, keyed by id at runtime where tsc cannot check them, so
 * `tests/unit/settings-sections-messages.test.ts` asserts each matches the English above.
 */

type SettingsTranslator = ReturnType<typeof useTranslations<"settings">>;

type DynamicTranslate = (key: string) => string;

function dynamic(t: SettingsTranslator): DynamicTranslate {
  return t as unknown as DynamicTranslate;
}

/** A page, block or group id as a catalog key segment: `default-response` is `defaultResponse`. */
export function sectionMessageName(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase());
}

export function settingsSectionName(t: SettingsTranslator, item: SettingItem): string {
  return dynamic(t)(`sections.${sectionMessageName(item.id)}.name`);
}

export function settingsSectionDescription(t: SettingsTranslator, item: SettingItem): string {
  return dynamic(t)(`sections.${sectionMessageName(item.id)}.desc`);
}

export function settingsBlockName(t: SettingsTranslator, id: string): string {
  return dynamic(t)(`blocks.${sectionMessageName(id)}.name`);
}

export function settingsBlockDescription(t: SettingsTranslator, id: string): string {
  return dynamic(t)(`blocks.${sectionMessageName(id)}.desc`);
}

export function settingsGroupLabel(t: SettingsTranslator, group: SettingsGroup): string {
  return dynamic(t)(`navGroups.${sectionMessageName(group.id)}`);
}
