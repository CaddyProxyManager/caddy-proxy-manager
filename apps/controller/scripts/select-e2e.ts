/**
 * Picks the e2e specs a change can break, from the files it touches. A path no rule names runs the
 * whole suite, so a gap here costs CI time, never coverage. A rule too narrow does cost coverage:
 * nothing runs on merge, only `e2e-full` or a dispatch runs everything.
 *
 *   git diff --name-only main... | bun apps/controller/scripts/select-e2e.ts --base main
 *
 * `--base` lets it diff the message catalog by namespace; without it a catalog change runs it all.
 * Prints `all`, `none` or Playwright filters. Under Actions it also writes `mode` and `specs` to
 * GITHUB_OUTPUT and the reasoning to the step summary.
 */

/** Spec path prefixes, relative to tests/e2e. */
type Specs = readonly string[];

type Rule = { match: readonly (string | RegExp)[]; specs: Specs };

const SRC = "apps/controller/src/";
const APP = `${SRC}app/`;
const DASH = `${APP}(dashboard)/`;
const LIB = `${SRC}lib/`;
const MODELS = `${LIB}models/`;
const V1 = `${APP}api/v1/`;
const AGENT = "apps/agent/src/";

const AUTH: Specs = [
  "auth/",
  "setup/",
  "users/",
  "api/api-security",
  "functional/legacy-password-gate",
  "functional/oauth-",
  "functional/oidc-",
  "functional/forward-auth",
];
const FORWARD_AUTH: Specs = [
  "auth/portal",
  "auth/forward-auth-generic",
  "functional/forward-auth",
  "functional/oauth-",
  "functional/oidc-backchannel-logout",
];
// The functional specs build their hosts through the host dialog, so they cover it too.
const PROXY_HOSTS: Specs = ["proxy-hosts/", "functional/", "mobile/", "dashboard"];
const WAF: Specs = ["proxy-hosts/waf", "functional/waf-"];
const CERTIFICATES: Specs = [
  "certificates/",
  "functional/mtls",
  "functional/acme-custom-ca",
  "proxy-hosts/wildcard-dns-guard",
];
const L4: Specs = ["l4-proxy-hosts", "functional/l4-"];
const ACCESS_LISTS: Specs = [
  "access-lists",
  "functional/access-control",
  "functional/access-list-ip-rules",
];
const ANALYTICS: Specs = [
  "analytics/",
  "functional/analytics-traffic-ingestion",
  "functional/waf-event-ingestion",
];
const LOGS: Specs = ["analytics/logs"];
const GEOIP: Specs = [
  "proxy-hosts/geoblock",
  "functional/geoblock-response-body",
  "analytics/analytics-country-breakdown",
  "analytics/analytics-map",
];
const USERS: Specs = ["users/", "auth/sessions", "auth/disabled-user", "auth/account-security"];
const GROUPS: Specs = ["users/", "functional/oidc-group-sync", "functional/oauth-role-injection"];
const NAV: Specs = ["command-palette", "mobile/", "dashboard"];
const NOTIFICATIONS: Specs = ["notifications", "auth/email-password-reset", "settings/"];
const API: Specs = ["api/"];
const SETTINGS_PAGE: Specs = ["settings/", "auth/", "notifications"];

/** First match wins, so a file's own rule sits above its folder's. */
export const RULES: readonly Rule[] = [
  // Nothing the stack runs.
  {
    match: [
      /\.md$/,
      "LICENSE",
      ".env.example",
      ".vscode/",
      ".claude/",
      "local/",
      "apps/site/",
      "docker-tests/",
      "biome.jsonc",
      "scripts/check-bundle-budget.ts",
      "scripts/test-all.sh",
      "scripts/publish-deploy-repo.sh",
      "docker/deploy-repo/",
      ".github/ISSUE_TEMPLATE/",
      ".github/FUNDING.yml",
      ".github/dependabot.yml",
      /^\.github\/workflows\/(?!e2e\.yml$)/,
      "apps/controller/tests/unit/",
      "apps/controller/tests/integration/",
      "apps/controller/tests/upgrade/",
      "apps/agent/tests/",
      `${SRC}types/`,
      "apps/controller/scripts/coverage-ratchet.ts",
      "apps/controller/scripts/demo.ts",
      "apps/controller/scripts/seed-demo.ts",
      "apps/controller/scripts/generate-sqlite-schema.ts",
      "apps/controller/scripts/with-test-db.ts",
    ],
    specs: [],
  },

  { match: [`${LIB}demo/`], specs: ["demo-mode"] },
  { match: [`${APP}api/health/`], specs: ["container-health"] },

  { match: [`${LIB}captcha/`, `${DASH}settings/CaptchaSection.tsx`], specs: ["auth/captcha-cap"] },
  {
    match: [
      `${LIB}ldap/`,
      `${MODELS}ldap-directories.ts`,
      `${DASH}settings/LdapDirectoriesSection.tsx`,
      `${DASH}settings/ldap-actions.ts`,
    ],
    specs: ["auth/ldap"],
  },
  {
    match: [
      `${LIB}forward-auth/`,
      `${APP}api/forward-auth/`,
      `${APP}(auth)/portal/`,
      `${SRC}components/proxy-hosts/forward-auth/`,
      `${MODELS}forward-auth.ts`,
      `${V1}forward-auth-sessions/`,
    ],
    specs: FORWARD_AUTH,
  },
  {
    match: [
      `${LIB}auth/`,
      `${LIB}services/`,
      `${SRC}components/auth/`,
      `${APP}(auth)/`,
      `${APP}api/auth/`,
      `${APP}api/sign-in/`,
      `${APP}api/password-reset/`,
      `${APP}api/internal/`,
      `${MODELS}oauth-providers.ts`,
      `${MODELS}emailed-links.ts`,
      `${MODELS}sessions.ts`,
      `${DASH}settings/OAuthProvidersSection.tsx`,
      `${DASH}settings/GroupMappingFields.tsx`,
      `${V1}oauth-providers/`,
      `${V1}sessions/`,
    ],
    specs: AUTH,
  },
  {
    match: [
      `${LIB}setup.ts`,
      `${LIB}migration/`,
      `${APP}setup/`,
      `${APP}api/setup/`,
      `${SRC}components/setup/`,
    ],
    specs: ["setup/"],
  },

  {
    match: [
      `${LIB}waf/`,
      `${SRC}components/proxy-hosts/waf/`,
      `${DASH}waf/`,
      `${APP}api/waf-events/`,
      `${MODELS}waf-events.ts`,
      `${MODELS}waf-presets.ts`,
      `${MODELS}crs-plugins.ts`,
      `${V1}waf-presets/`,
      `${V1}crs-plugins/`,
    ],
    specs: WAF,
  },
  {
    match: [`${LIB}geoip/`, `${LIB}agent/geoip.ts`, `${APP}api/geoip-status/`],
    specs: GEOIP,
  },
  {
    match: [
      `${LIB}proxy-hosts/`,
      `${SRC}components/proxy-hosts/`,
      `${DASH}proxy-hosts/`,
      `${APP}api/proxy-hosts/`,
      `${V1}proxy-hosts/`,
      `${MODELS}proxy-hosts.ts`,
      `${MODELS}bulk-hosts.ts`,
    ],
    specs: PROXY_HOSTS,
  },
  {
    match: [
      `${LIB}l4/`,
      `${SRC}components/l4-proxy-hosts/`,
      `${DASH}l4-proxy-hosts/`,
      `${APP}api/l4-ports/`,
      `${V1}l4-proxy-hosts/`,
      `${MODELS}l4-proxy-hosts.ts`,
    ],
    specs: L4,
  },
  {
    match: [
      `${LIB}access-lists/`,
      `${DASH}access-lists/`,
      `${V1}access-lists/`,
      `${MODELS}access-lists.ts`,
    ],
    specs: ACCESS_LISTS,
  },
  {
    match: [
      `${LIB}certificates/`,
      `${LIB}dns/`,
      `${LIB}reachability/`,
      `${LIB}agent/certificate-file-sources.ts`,
      `${SRC}components/certificates/`,
      `${SRC}components/ca-certificates/`,
      `${SRC}components/mtls-roles/`,
      `${DASH}certificates/`,
      `${DASH}settings/DnsDelegationSection.tsx`,
      `${APP}api/certificates/`,
      `${V1}certificates/`,
      `${V1}ca-certificates/`,
      `${V1}client-certificates/`,
      `${V1}mtls-roles/`,
      `${V1}dns-providers/`,
      `${MODELS}certificates.ts`,
      `${MODELS}ca-certificates.ts`,
      `${MODELS}certificate-files.ts`,
      `${MODELS}issued-client-certificates.ts`,
      `${MODELS}mtls-access-rules.ts`,
      `${MODELS}mtls-roles.ts`,
      `${AGENT}certificates.ts`,
      `${AGENT}certificate-files.ts`,
    ],
    specs: CERTIFICATES,
  },
  {
    match: [`${DASH}logs/`, `${APP}api/logs/`, `${LIB}agent/log-access.ts`, `${AGENT}logs.ts`],
    specs: LOGS,
  },
  {
    match: [
      `${LIB}analytics/`,
      `${LIB}clickhouse/`,
      `${LIB}agent/analytics-ingest.ts`,
      `${DASH}analytics/`,
      `${APP}api/analytics/`,
      `${AGENT}analytics/`,
    ],
    specs: ANALYTICS,
  },

  {
    match: [
      `${DASH}agents/`,
      `${SRC}components/agents/`,
      `${MODELS}agents.ts`,
      `${MODELS}host-agents.ts`,
    ],
    specs: ["agents", "functional/agent"],
  },
  {
    match: [
      `${LIB}caddy/image-build/`,
      `${APP}api/caddy-build/`,
      `${SRC}components/caddy-modules/`,
    ],
    specs: ["functional/caddy-rebuild", "settings/"],
  },
  { match: [`${LIB}secrets/`], specs: ["functional/secret-rotation", "settings/backup"] },
  {
    match: [`${LIB}backup/`, `${APP}api/backup/`, `${V1}backup/`, `${DASH}settings/backup/`],
    specs: ["settings/backup", "setup/setup-migrate"],
  },
  {
    match: [`${LIB}branding/`, `${APP}api/branding/`, `${DASH}settings/AccentColorPicker.tsx`],
    specs: ["settings/branding"],
  },
  {
    match: [
      `${LIB}email/`,
      `${LIB}notifications/`,
      `${MODELS}notification-preferences.ts`,
      `${MODELS}push-subscriptions.ts`,
      `${DASH}settings/EmailSection.tsx`,
      `${DASH}profile/NotificationsSection.tsx`,
      `${DASH}profile/notification-actions.ts`,
    ],
    specs: NOTIFICATIONS,
  },
  {
    match: [`${DASH}settings/history/`, `${LIB}settings/revisions.ts`],
    specs: ["settings/settings-history"],
  },
  {
    match: [`${LIB}dashboard-host/`, `${DASH}settings/DashboardHostSection.tsx`],
    specs: ["settings/", "dashboard"],
  },
  { match: [`${DASH}settings/`], specs: SETTINGS_PAGE },

  {
    match: [
      `${DASH}groups/`,
      `${SRC}components/groups/`,
      `${MODELS}groups.ts`,
      `${MODELS}group-grants.ts`,
      `${MODELS}group-idp-mappings.ts`,
      `${V1}groups/`,
    ],
    specs: GROUPS,
  },
  {
    match: [
      `${LIB}users/`,
      `${DASH}users/`,
      `${DASH}profile/`,
      `${DASH}view-as/`,
      `${SRC}components/users/`,
      `${SRC}components/UserAvatar.tsx`,
      `${SRC}components/theme/`,
      `${APP}api/user/`,
      `${V1}users/`,
      `${MODELS}user.ts`,
      `${MODELS}nav-preferences.ts`,
      `${MODELS}table-density.ts`,
    ],
    specs: USERS,
  },
  {
    match: [`${LIB}audit/`, `${DASH}audit-log/`, `${V1}audit-log/`, `${MODELS}audit.ts`],
    specs: ["audit-log"],
  },
  {
    match: [`${DASH}api-tokens/`, `${V1}tokens/`, `${MODELS}api-tokens.ts`],
    specs: ["api/api-tokens", "api/api-security"],
  },
  { match: [`${DASH}api-docs/`, `${V1}openapi.json`], specs: ["api/api-docs"] },
  { match: [V1], specs: API },

  {
    match: [
      `${SRC}components/command-palette/`,
      `${SRC}components/mobile/`,
      `${LIB}nav/`,
      `${DASH}more/`,
    ],
    specs: NAV,
  },
  {
    match: [
      `${DASH}page.tsx`,
      `${DASH}OverviewClient.tsx`,
      `${DASH}overview-actions.ts`,
      `${SRC}components/overview/`,
      `${LIB}setup-checklist/`,
    ],
    specs: ["dashboard"],
  },
  // On the overview and every host's page.
  {
    match: [`${LIB}attention/`, `${SRC}components/attention/`],
    specs: ["dashboard", "proxy-hosts/host-detail"],
  },

  // The specs and their infrastructure.
  { match: [/^apps\/controller\/tests\/e2e\/[\w./-]+\.spec\.ts$/], specs: [] },
  // Everything else - shared UI, the db, Caddy config, the agent link, settings, images,
  // dependencies, the suite's own setup - reaches every spec.
];

export const MESSAGES = "apps/controller/messages/en.json";

/**
 * Nearly every UI change edits the catalog, so it is narrowed by the namespaces that changed.
 * The shared ones (common, nav, ui, errors, passwordPolicy) and any new one stay unlisted.
 */
export const NAMESPACES: Readonly<Record<string, Specs>> = {
  accessLists: ACCESS_LISTS,
  agents: ["agents", "functional/agent"],
  analytics: ANALYTICS,
  attention: ["dashboard", "proxy-hosts/host-detail"],
  apiDocs: ["api/api-docs"],
  auditLog: ["audit-log"],
  auth: AUTH,
  caCertificates: CERTIFICATES,
  caddyModules: ["functional/caddy-rebuild", "settings/"],
  certificates: CERTIFICATES,
  commandPalette: NAV,
  email: NOTIFICATIONS,
  groups: GROUPS,
  l4ProxyHosts: L4,
  logs: LOGS,
  mtlsRoles: CERTIFICATES,
  overview: ["dashboard"],
  profile: USERS,
  proxyHosts: PROXY_HOSTS,
  settings: SETTINGS_PAGE,
  setup: ["setup/"],
  users: USERS,
  waf: WAF,
};

/** Top-level catalog keys whose subtree differs between two versions of en.json. */
export function changedNamespaces(before: string, after: string): string[] {
  const a = JSON.parse(before) as Record<string, unknown>;
  const b = JSON.parse(after) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
}

export type Selection =
  | { mode: "all"; reasons: string[] }
  | { mode: "none"; reasons: string[] }
  | { mode: "some"; specs: string[]; reasons: string[] };

const E2E_PREFIX = "apps/controller/tests/e2e/";

/** Rendered pages are what the accessibility spec crawls, so any of them can fail it. */
const RENDERS = /^apps\/controller\/src\/.*\.(tsx|css)$/;

/** `namespaces` are the catalog's changed ones; without them a catalog change runs everything. */
export function selectSpecs(changed: readonly string[], namespaces?: readonly string[]): Selection {
  const specs = new Set<string>();
  const reasons: string[] = [];
  for (const file of changed.map((f) => f.trim()).filter(Boolean)) {
    if (file === MESSAGES) {
      const unmapped = namespaces ? namespaces.filter((n) => !NAMESPACES[n]) : ["(unknown)"];
      if (unmapped.length > 0) {
        reasons.push(`${file}: namespace ${unmapped.join(", ")}, so every spec`);
        return { mode: "all", reasons };
      }
      const picked = [...(namespaces ?? []).flatMap((n) => NAMESPACES[n]), "accessibility"];
      for (const spec of picked) specs.add(spec);
      reasons.push(`${file} (${namespaces?.join(", ")}): ${[...new Set(picked)].join(", ")}`);
      continue;
    }
    const rule = RULES.find((r) =>
      r.match.some((m) => (typeof m === "string" ? file.startsWith(m) : m.test(file))),
    );
    if (!rule) {
      reasons.push(`${file}: no narrower rule, so every spec`);
      return { mode: "all", reasons };
    }
    const picked = file.startsWith(E2E_PREFIX) ? [file.slice(E2E_PREFIX.length)] : [...rule.specs];
    if (RENDERS.test(file)) picked.push("accessibility");
    for (const spec of picked) specs.add(spec);
    if (picked.length > 0) reasons.push(`${file}: ${picked.join(", ")}`);
  }
  if (specs.size === 0) return { mode: "none", reasons };
  return { mode: "some", specs: [...specs].sort(), reasons };
}

/** Playwright reads each filter as a regex over the spec's path. */
export function playwrightFilters(specs: readonly string[]): string[] {
  return specs.map((spec) => `tests/e2e/${spec}`);
}

if (import.meta.main) {
  const { appendFileSync } = await import("node:fs");
  const argv = process.argv.slice(2);
  const baseAt = argv.indexOf("--base");
  const base = baseAt === -1 ? undefined : argv.splice(baseAt, 2)[1];
  const input = argv.length > 0 ? argv : (await Bun.stdin.text()).split(/\r?\n/);
  let namespaces: string[] | undefined;
  if (base && input.includes(MESSAGES)) {
    // A catalog missing on either side (added, deleted, unparsable) leaves namespaces unknown.
    const show = (ref: string) =>
      Bun.spawnSync(["git", "show", `${ref}:${MESSAGES}`], { stderr: "ignore" });
    const [before, after] = [show(base), show("HEAD")];
    if (before.success && after.success) {
      try {
        namespaces = changedNamespaces(before.stdout.toString(), after.stdout.toString());
      } catch {}
    }
  }
  const selection = selectSpecs(input, namespaces);
  const specs = selection.mode === "some" ? playwrightFilters(selection.specs).join(" ") : "";
  console.log(selection.mode === "some" ? specs : selection.mode);

  const { GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `mode=${selection.mode}\nspecs=${specs}\n`);
  if (GITHUB_STEP_SUMMARY) {
    const heading = { all: "Full suite", none: "No e2e specs", some: "Selected e2e specs" }[
      selection.mode
    ];
    const lines = selection.reasons.map((r) => `- \`${r.replace(/`/g, "'")}\``);
    appendFileSync(GITHUB_STEP_SUMMARY, `### ${heading}\n\n${lines.join("\n")}\n`);
  }
}
