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
import type { Hue } from "@/src/components/ui/accent";
import type { useTranslations } from "next-intl";

/** `id` is the anchor, the `settings.blocks.*` key, and where legacy links redirect. */
export type SettingsBlock = {
  id: string;
  name: string;
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
          { id: "general", name: "General" },
          {
            id: "acme",
            name: "ACME Server",
            envSearch: ["ACME_CA_ROOT_DIR"],
          },
          {
            id: "updates",
            name: "Updates",
            envSearch: ["UPDATE_CHECK_ENABLED", "UPDATE_IMAGE_REPOSITORY"],
          },
          {
            id: "branding",
            name: "Branding",
            envSearch: ["ACCENT_COLOR"],
          },
          {
            id: "instance",
            name: "Instance",
            envSearch: ["APP_NAME", "BASE_URL"],
          },
          {
            id: "avatars",
            name: "User Avatars",
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
          },
          {
            id: "error-pages",
            name: "Error Pages",
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
            env: ["CADDY_BUILD_TIMEOUT"],
          },
          {
            id: "global-caddy-config",
            name: "Global Caddyfile",
          },
          {
            id: "http-cache",
            name: "HTTP Cache",
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
              "NOTIFY_DISABLED_ACCOUNT_OWNER",
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
          },
          {
            id: "dns-resolvers",
            name: "DNS Resolvers",
          },
          {
            id: "upstream-dns",
            name: "Upstream DNS Pinning",
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
          },
          {
            id: "http-protocols",
            name: "HTTP Versions",
          },
          {
            id: "compression",
            name: "Compression",
          },
          {
            id: "tailscale",
            name: "Tailscale",
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
          },
          {
            id: "sign-in",
            name: "Sign-in",
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
          },
          {
            id: "two-factor",
            name: "Two-factor Sign-in",
          },
          {
            id: "password-policy",
            name: "Password Policy",
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
            env: ["FORWARD_AUTH_INTERNAL_URL"],
          },
          {
            id: "forward-auth",
            name: "Forward Auth Defaults",
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
            envSearch: [
              "ANALYTICS_ENABLED",
              "CLICKHOUSE_URL",
              "CLICKHOUSE_USER",
              "CLICKHOUSE_PASSWORD",
              "CLICKHOUSE_DB",
              "CLICKHOUSE_RETENTION_DAYS",
            ],
          },
          { id: "metrics", name: "Metrics & Monitoring" },
          { id: "logging", name: "Access Logging" },
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

/**
 * The rail's icon colours, by section id. Where a section configures a page, the page's hue: the
 * agent teal, CrowdSec red beside the WAF, observability blue like Analytics.
 */
export const SETTINGS_HUES: Record<string, Hue> = {
  general: "blue",
  responses: "red",
  "caddy-build": "orange",
  dashboard: "purple",
  agent: "teal",
  email: "pink",
  dns: "cyan",
  network: "green",
  authentication: "yellow",
  "forward-auth": "purple",
  geo: "teal",
  crowdsec: "red",
  observability: "blue",
};

/**
 * The settings header's height, measured by SettingsFrame, for anything that scrolls into view
 * beneath it. Here rather than there: PageBlocks needs it, and the docs site renders PageBlocks.
 */
export const HEADER_HEIGHT_VAR = "--cpm-settings-header-height";

/** Where the rail takes the revision and the staged controls, filled by SettingsFrame. */
export const STAGED_SLOT_ID = "settings-rail-staged";

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

export function settingsGroupLabel(t: SettingsTranslator, group: SettingsGroup): string {
  return dynamic(t)(`navGroups.${sectionMessageName(group.id)}`);
}
