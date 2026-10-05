/**
 * The controller's side of setup, in the browser, behind the real screens (via the shims and
 * fake-api.ts). Nothing persists. `currentSimulation()` is null unless a demo started one, so the
 * sign-in demo elsewhere keeps failing every attempt.
 */
import { passwordPolicyMessage } from "@cpm/controller/src/lib/auth/password/policy-message";
import type { MigrationGroupId } from "@cpm/controller/src/lib/migration/selection";
import type { SetupStage } from "@cpm/controller/src/lib/setup";
import { t } from "./catalog";
import { json, serveApi } from "./fake-api";

/** Where the reader "reached" the instance: a LAN name, so the dashboard host has one to claim. */
const INITIAL_ORIGIN = "http://cpm.lan:3000";

const RESTART_DOWNTIME_MS = 2500;

/** Long enough to see a pending state, short enough not to be a wait. */
const LATENCY_MS = 700;

export type LegacyCandidate = {
  path: string;
  sizeBytes: number;
  users: number;
  proxyHosts: number;
  certificates: number;
  groupCounts: Record<MigrationGroupId, number>;
  lastUpdatedAt: string | null;
  needsLegacyKey: boolean;
};

/** A live database and a backup under an old key. */
export const LEGACY_CANDIDATES: LegacyCandidate[] = [
  {
    path: "/app/data/caddy-proxy-manager.db",
    sizeBytes: 3_561_472,
    users: 3,
    proxyHosts: 14,
    certificates: 6,
    groupCounts: {
      users: 41,
      proxyHosts: 17,
      certificates: 6,
      accessLists: 4,
      oauthProviders: 1,
      agents: 1,
      settings: 12,
      auditLog: 1873,
    },
    lastUpdatedAt: "2026-09-21T18:04:12Z",
    needsLegacyKey: false,
  },
  {
    path: "/app/data/caddy-proxy-manager.db.bak",
    sizeBytes: 2_949_120,
    users: 2,
    proxyHosts: 11,
    certificates: 5,
    groupCounts: {
      users: 28,
      proxyHosts: 13,
      certificates: 5,
      accessLists: 3,
      oauthProviders: 1,
      agents: 0,
      settings: 12,
      auditLog: 1204,
    },
    lastUpdatedAt: "2026-03-02T09:47:55Z",
    needsLegacyKey: true,
  },
];

/** Their passwords are not known here. */
const LEGACY_ACCOUNTS = ["admin", "sam", "priya"];
const LEGACY_PROVIDER = "Authentik";

const LEGACY_DASHBOARD_HOST = { id: 7, name: "CPM dashboard", domains: ["cpm.lan"], enabled: true };

type Account = { username: string; password: string | null };

export type SimulationState = {
  hasLegacyDatabase: boolean;
  /** The address bar. */
  origin: string;
  path: string;
  /** Bumped per load, so the page remounts as a real navigation would. */
  load: number;
  migrationDeclined: boolean;
  migratedFrom: string | null;
  migratedGroups: MigrationGroupId[];
  accounts: Account[];
  providers: string[];
  /** A session belongs to the origin it was made on, as the app's cookie does. */
  sessionOrigin: string | null;
  completed: boolean;
  /** For the cleanup command. */
  stored: string[];
  upAt: number | null;
};

function initialState(hasLegacyDatabase: boolean): SimulationState {
  const state: SimulationState = {
    hasLegacyDatabase,
    origin: INITIAL_ORIGIN,
    path: "/",
    load: 0,
    migrationDeclined: false,
    migratedFrom: null,
    migratedGroups: [],
    accounts: [],
    providers: [],
    sessionOrigin: null,
    completed: false,
    stored: [],
    upAt: null,
  };
  return { ...state, path: route(state, "/") };
}

/** `getSetupState` from lib/setup.ts, over this state instead of the database. */
export function stageOf(state: SimulationState): SetupStage {
  if (state.completed) return "complete";
  if (state.accounts.length === 0 && state.providers.length === 0) {
    const settled = state.migrationDeclined || state.migratedFrom !== null;
    return !settled && state.hasLegacyDatabase ? "migrate" : "account";
  }
  return isSignedIn(state) ? "settings" : "verify";
}

const STAGE_PATHS: Record<SetupStage, string> = {
  migrate: "/setup/migrate",
  account: "/setup",
  verify: "/login",
  settings: "/setup/settings",
  complete: "/",
};

export function isSignedIn(state: SimulationState): boolean {
  return state.sessionOrigin === state.origin;
}

/** The redirects each page and the proxy perform, followed to where a request actually lands. */
function route(state: SimulationState, path: string): string {
  const stage = stageOf(state);
  const home = STAGE_PATHS[stage];
  switch (path) {
    case "/setup/migrate":
    case "/setup":
    case "/setup/settings":
      return home === path ? path : route(state, home);
    case "/login":
      return isSignedIn(state) ? route(state, "/") : path;
    case "/setup/done":
      if (!isSignedIn(state)) return "/login";
      if (!state.completed) return route(state, "/setup");
      return state.migratedFrom ? path : "/";
    default:
      if (stage !== "complete") return home;
      return isSignedIn(state) ? "/" : "/login";
  }
}

const pause = (ms = LATENCY_MS) => new Promise((resolve) => setTimeout(resolve, ms));

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

export class Simulation {
  private state: SimulationState;
  private readonly listeners = new Set<() => void>();

  constructor(hasLegacyDatabase: boolean) {
    this.state = initialState(hasLegacyDatabase);
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = () => this.state;

  private set(patch: Partial<SimulationState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  reset(hasLegacyDatabase: boolean) {
    this.state = { ...initialState(hasLegacyDatabase), load: this.state.load + 1 };
    for (const listener of this.listeners) listener();
  }

  navigate(href: string) {
    const url = new URL(href, `${this.state.origin}${this.state.path}`);
    const next = { ...this.state, origin: url.origin };
    this.set({ origin: url.origin, path: route(next, url.pathname), load: this.state.load + 1 });
  }

  // Server actions (app/setup/actions.ts, app/setup/migrate/actions.ts).

  async createFirstAdmin(formData: FormData): Promise<{ error: string | null }> {
    await pause();
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const confirmation = String(formData.get("passwordConfirmation") ?? "");

    if (!username) return { error: t("setup.errors.usernameRequired") };
    if (password !== confirmation) return { error: t("setup.errors.passwordsDiffer") };
    const policyFailure = passwordPolicyMessage(t, password, t("passwordPolicy.subject.password"));
    if (policyFailure) return { error: policyFailure };

    this.set({ accounts: [{ username: username.toLowerCase(), password }] });
    this.navigate("/login");
    return { error: null };
  }

  async configureFirstOAuthProvider(formData: FormData): Promise<{ error: string | null }> {
    await pause();
    const name = String(formData.get("providerName") ?? "").trim();
    const clientId = String(formData.get("clientId") ?? "").trim();
    const clientSecret = String(formData.get("clientSecret") ?? "").trim();
    const issuer = String(formData.get("issuer") ?? "").trim();

    if (!name) return { error: t("setup.errors.displayNameRequired") };
    if (!clientId || !clientSecret) return { error: t("setup.errors.clientIdAndSecretRequired") };
    if (!/^https?:\/\/\S+$/.test(issuer)) return { error: t("setup.errors.issuerMustBeUrl") };

    this.set({ providers: [name] });
    this.navigate("/login");
    return { error: null };
  }

  async skipMigration(): Promise<void> {
    await pause();
    this.set({ migrationDeclined: true });
    this.navigate("/setup");
  }

  // Sign-in (lib/auth/client).

  async signInUsername(username: string, password: string) {
    await pause();
    const account = this.state.accounts.find((entry) => entry.username === username.toLowerCase());
    // An imported account's password is unknowable here, so any password opens one.
    if (!account || (account.password !== null && account.password !== password)) {
      // Better Auth's username plugin's answer.
      return { error: { status: 401, code: "INVALID_USERNAME_OR_PASSWORD" } };
    }
    this.set({ sessionOrigin: this.state.origin });
    return { error: null };
  }

  async signInSocial(callbackURL = "/") {
    await pause();
    this.set({ sessionOrigin: this.state.origin });
    this.navigate(callbackURL);
  }

  // Route handlers.

  /** Answers the paths this simulation owns, or null to let the request through. */
  async handle(url: URL, init: RequestInit | undefined): Promise<Response | null> {
    const method = (init?.method ?? "GET").toUpperCase();
    switch (`${method} ${url.pathname}`) {
      case "POST /api/setup/migrate":
        return this.migrate(JSON.parse(String(init?.body ?? "{}")));
      case "POST /api/setup/complete":
        return this.complete(init?.body as FormData);
      case "POST /api/setup/restart":
        this.set({ upAt: Date.now() + RESTART_DOWNTIME_MS });
        return json({ ok: true }, 202);
      case "GET /api/health":
        if (this.state.upAt !== null && Date.now() < this.state.upAt) {
          throw new TypeError("Failed to fetch");
        }
        return json({ ok: true });
      case "GET /api/setup/dashboard-reachable":
        return json({ ok: true });
      default:
        return null;
    }
  }

  private async migrate(body: {
    path?: string;
    groups?: MigrationGroupId[];
    legacyKey?: string;
  }): Promise<Response> {
    await pause(1600);
    const candidate = LEGACY_CANDIDATES.find((entry) => entry.path === body.path);
    const groups = body.groups ?? [];
    if (!candidate)
      return json({ ok: false, error: t("setup.migrateErrors.unknownDatabase") }, 400);
    if (groups.length === 0) {
      return json({ ok: false, error: t("setup.migrateErrors.chooseGroups") }, 400);
    }
    if (candidate.needsLegacyKey && !body.legacyKey?.trim()) {
      return json(
        {
          ok: false,
          code: "legacy-key-required",
          error: t("setup.migrateErrors.legacyKeyRequired"),
        },
        400,
      );
    }

    const accounts = groups.includes("users")
      ? LEGACY_ACCOUNTS.map((username) => ({ username, password: null }))
      : [];
    const providers = groups.includes("oauthProviders") ? [LEGACY_PROVIDER] : [];
    this.set({ migratedFrom: candidate.path, migratedGroups: groups, accounts, providers });

    const migratedSignIn = accounts.length > 0 || providers.length > 0;
    return json({
      ok: true,
      next: migratedSignIn ? "/login" : "/setup",
      migratedSignIn,
      restartToken: "simulated",
    });
  }

  private async complete(formData: FormData): Promise<Response> {
    await pause();
    if (!isSignedIn(this.state)) {
      return json({ ok: false, error: t("setup.errors.signInToFinish") }, 401);
    }

    const defaultDomain = String(formData.get("defaultDomain") ?? "").trim();
    if (defaultDomain.length === 0 || defaultDomain.length > 253) {
      return json({ ok: false, error: t("setup.errors.defaultDomainInvalid") }, 400);
    }
    if (
      formData.get("config:analytics_enabled") === "on" &&
      !String(formData.get("config:clickhouse_password") ?? "")
    ) {
      return json({ ok: false, error: t("setup.errors.analyticsPasswordRequired") }, 400);
    }
    const dashboardEnabled = formData.get("dashboardEnabled") === "on";
    const dashboardDomain = String(formData.get("dashboardDomain") ?? "").trim();
    if (dashboardEnabled && !HOSTNAME.test(dashboardDomain)) {
      return json({ ok: false, error: t("setup.errors.dashboardDomainInvalid") }, 400);
    }

    const idpName = String(formData.get("idpName") ?? "").trim();
    const providers =
      idpName && formData.get("idpClientId") ? [...this.state.providers, idpName] : undefined;

    // Storing a value is what frees its variable.
    const stored = SETTING_FIELDS.filter((field) => {
      const value = formData.get(field.key);
      return typeof value === "string" && value !== "";
    }).map((field) => field.env);

    this.set({ completed: true, stored, ...(providers && { providers }) });
    return json({
      ok: true,
      next: this.state.migratedFrom ? "/setup/done" : "/",
      restartToken: "simulated",
      dashboardOrigin: dashboardEnabled ? `http://${dashboardDomain.toLowerCase()}` : null,
    });
  }

  // What the setup pages pass their clients.

  domainClaims() {
    return this.state.migratedGroups.includes("proxyHosts") ? [LEGACY_DASHBOARD_HOST] : [];
  }

  /** `planEnvCleanup` from lib/migration/env-file.ts, over the fields below. */
  envCleanup() {
    const comment: string[] = [];
    const keep: string[] = [];
    for (const field of SETTING_FIELDS) {
      if (!this.state.stored.includes(field.env)) continue;
      (field.composeReads ? keep : comment).push(field.env);
    }
    const command =
      comment.length === 0
        ? null
        : [
            `migrated='${comment.join("|")}'`,
            `sed -i.bak -E "s/^([[:space:]]*)((export[[:space:]]+)?(\${migrated})[[:space:]]*=)/\\1# migrated to the database: \\2/" .env`,
          ].join("\n");
    return { comment, keep, command };
  }
}

type FieldKind = "string" | "number" | "boolean" | "tristate";

/**
 * lib/settings/registry.ts, repeated: it needs `node:net` and half of lib, which cannot be bundled
 * for a browser. Order, names and defaults follow SETTING_DEFINITIONS.
 */
export const SETTING_FIELDS: Array<{
  key: string;
  env: string;
  group: "application" | "authentication" | "email" | "analytics" | "geoip";
  kind: FieldKind;
  value: string | number | boolean | null;
  secret?: boolean;
  generatable?: boolean;
  gate?: boolean;
  composeReads?: boolean;
}> = [
  {
    key: "config:app_name",
    env: "APP_NAME",
    group: "application",
    kind: "string",
    value: "Caddy Proxy Manager",
  },
  {
    key: "config:accent_color",
    env: "ACCENT_COLOR",
    group: "application",
    kind: "string",
    value: "pink",
  },
  // What the page proposes from the address it was reached at, over the loopback default.
  {
    key: "config:base_url",
    env: "BASE_URL",
    group: "application",
    kind: "string",
    value: INITIAL_ORIGIN,
  },
  {
    key: "config:caddy_api_url",
    env: "CADDY_API_URL",
    group: "application",
    kind: "string",
    value: "http://caddy:2019",
  },
  {
    key: "config:caddy_monitor_enabled",
    env: "CADDY_MONITOR_ENABLED",
    group: "application",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:avatar_gravatar",
    env: "AVATAR_GRAVATAR",
    group: "application",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:forward_auth_internal_url",
    env: "FORWARD_AUTH_INTERNAL_URL",
    group: "application",
    kind: "string",
    value: "",
  },
  {
    key: "config:caddy_build_timeout",
    env: "CADDY_BUILD_TIMEOUT",
    group: "application",
    kind: "number",
    value: 1800,
  },
  {
    key: "config:update_check_enabled",
    env: "UPDATE_CHECK_ENABLED",
    group: "application",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:update_image_repository",
    env: "UPDATE_IMAGE_REPOSITORY",
    group: "application",
    kind: "string",
    value: "ghcr.io/caddyproxymanager/caddy-proxy-manager",
  },
  {
    key: "config:auth_allow_self_registration",
    env: "AUTH_ALLOW_SELF_REGISTRATION",
    group: "authentication",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:auth_allow_oauth_registration",
    env: "AUTH_ALLOW_OAUTH_REGISTRATION",
    group: "authentication",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:auth_allow_oauth_role_from_claims",
    env: "AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS",
    group: "authentication",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:auth_disable_local_users",
    env: "AUTH_DISABLE_LOCAL_USERS",
    group: "authentication",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:auth_trust_host",
    env: "AUTH_TRUST_HOST",
    group: "authentication",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:auth_require_password_change_on_legacy_hash",
    env: "AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH",
    group: "authentication",
    kind: "tristate",
    value: null,
  },
  {
    key: "config:auth_rate_limit_enabled",
    env: "AUTH_RATE_LIMIT_ENABLED",
    group: "authentication",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:auth_rate_limit_window",
    env: "AUTH_RATE_LIMIT_WINDOW",
    group: "authentication",
    kind: "number",
    value: 60,
  },
  {
    key: "config:auth_rate_limit_max",
    env: "AUTH_RATE_LIMIT_MAX",
    group: "authentication",
    kind: "number",
    value: 5,
  },
  {
    key: "config:login_max_attempts",
    env: "LOGIN_MAX_ATTEMPTS",
    group: "authentication",
    kind: "number",
    value: 5,
  },
  {
    key: "config:login_window_ms",
    env: "LOGIN_WINDOW_MS",
    group: "authentication",
    kind: "number",
    value: 300_000,
  },
  {
    key: "config:login_block_ms",
    env: "LOGIN_BLOCK_MS",
    group: "authentication",
    kind: "number",
    value: 900_000,
  },
  {
    key: "config:account_lock_enabled",
    env: "ACCOUNT_LOCK_ENABLED",
    group: "authentication",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:account_lock_free_failures",
    env: "ACCOUNT_LOCK_FREE_FAILURES",
    group: "authentication",
    kind: "number",
    value: 5,
  },
  {
    key: "config:account_lock_base_delay_ms",
    env: "ACCOUNT_LOCK_BASE_DELAY_MS",
    group: "authentication",
    kind: "number",
    value: 1000,
  },
  {
    key: "config:account_lock_max_delay_ms",
    env: "ACCOUNT_LOCK_MAX_DELAY_MS",
    group: "authentication",
    kind: "number",
    value: 900_000,
  },
  {
    key: "config:account_lock_disable_enabled",
    env: "ACCOUNT_LOCK_DISABLE_ENABLED",
    group: "authentication",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:account_lock_disable_after",
    env: "ACCOUNT_LOCK_DISABLE_AFTER",
    group: "authentication",
    kind: "number",
    value: 10,
  },
  {
    key: "config:forward_auth_allowed_ports",
    env: "FORWARD_AUTH_ALLOWED_PORTS",
    group: "authentication",
    kind: "string",
    value: "",
  },
  {
    key: "config:forward_auth_sequential_user_ids",
    env: "FORWARD_AUTH_SEQUENTIAL_USER_IDS",
    group: "authentication",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:smtp_enabled",
    env: "SMTP_ENABLED",
    group: "email",
    kind: "tristate",
    value: false,
    gate: true,
  },
  {
    key: "config:smtp_host",
    env: "SMTP_HOST",
    group: "email",
    kind: "string",
    value: "",
  },
  {
    key: "config:smtp_port",
    env: "SMTP_PORT",
    group: "email",
    kind: "number",
    value: 587,
  },
  {
    key: "config:smtp_security",
    env: "SMTP_SECURITY",
    group: "email",
    kind: "string",
    value: "starttls",
  },
  {
    key: "config:smtp_username",
    env: "SMTP_USERNAME",
    group: "email",
    kind: "string",
    value: "",
  },
  {
    key: "config:smtp_password",
    env: "SMTP_PASSWORD",
    group: "email",
    kind: "string",
    value: "",
    secret: true,
  },
  {
    key: "config:smtp_from",
    env: "SMTP_FROM",
    group: "email",
    kind: "string",
    value: "",
  },
  {
    key: "config:email_alert_recipients",
    env: "EMAIL_ALERT_RECIPIENTS",
    group: "email",
    kind: "string",
    value: "",
  },
  {
    key: "config:certificate_expiry_alert_days",
    env: "CERTIFICATE_EXPIRY_ALERT_DAYS",
    group: "email",
    kind: "number",
    value: 14,
  },
  {
    key: "config:notify_account_disabled",
    env: "NOTIFY_ACCOUNT_DISABLED",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_admin_locked",
    env: "NOTIFY_ADMIN_LOCKED",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_admin_added",
    env: "NOTIFY_ADMIN_ADDED",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_agent_offline",
    env: "NOTIFY_AGENT_OFFLINE",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_agent_offline_minutes",
    env: "NOTIFY_AGENT_OFFLINE_MINUTES",
    group: "email",
    kind: "number",
    value: 5,
  },
  {
    key: "config:notify_upstream_errors",
    env: "NOTIFY_UPSTREAM_ERRORS",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_upstream_error_count",
    env: "NOTIFY_UPSTREAM_ERROR_COUNT",
    group: "email",
    kind: "number",
    value: 10,
  },
  {
    key: "config:notify_upstream_error_minutes",
    env: "NOTIFY_UPSTREAM_ERROR_MINUTES",
    group: "email",
    kind: "number",
    value: 5,
  },
  {
    key: "config:notify_caddy_apply",
    env: "NOTIFY_CADDY_APPLY",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_agent_problems",
    env: "NOTIFY_AGENT_PROBLEMS",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_geoip_failed",
    env: "NOTIFY_GEOIP_FAILED",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_crs_plugin_disabled",
    env: "NOTIFY_CRS_PLUGIN_DISABLED",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_update_available",
    env: "NOTIFY_UPDATE_AVAILABLE",
    group: "email",
    kind: "boolean",
    value: true,
  },
  {
    key: "config:notify_disabled_account_owner",
    env: "NOTIFY_DISABLED_ACCOUNT_OWNER",
    group: "email",
    kind: "boolean",
    value: false,
  },
  {
    key: "config:analytics_enabled",
    env: "ANALYTICS_ENABLED",
    group: "analytics",
    kind: "tristate",
    value: false,
    gate: true,
  },
  {
    key: "config:clickhouse_url",
    env: "CLICKHOUSE_URL",
    group: "analytics",
    kind: "string",
    value: "http://clickhouse:8123",
  },
  {
    key: "config:clickhouse_user",
    env: "CLICKHOUSE_USER",
    group: "analytics",
    kind: "string",
    value: "cpm",
    composeReads: true,
  },
  {
    key: "config:clickhouse_password",
    env: "CLICKHOUSE_PASSWORD",
    group: "analytics",
    kind: "string",
    value: "",
    secret: true,
    generatable: true,
    composeReads: true,
  },
  {
    key: "config:clickhouse_db",
    env: "CLICKHOUSE_DB",
    group: "analytics",
    kind: "string",
    value: "analytics",
    composeReads: true,
  },
  {
    key: "config:clickhouse_retention_days",
    env: "CLICKHOUSE_RETENTION_DAYS",
    group: "analytics",
    kind: "number",
    value: 30,
  },
  {
    key: "config:geoip_enabled",
    env: "GEOIP_ENABLED",
    group: "geoip",
    kind: "tristate",
    value: false,
    gate: true,
  },
  {
    key: "config:geoipupdate_account_id",
    env: "GEOIPUPDATE_ACCOUNT_ID",
    group: "geoip",
    kind: "string",
    value: "",
  },
  {
    key: "config:geoipupdate_license_key",
    env: "GEOIPUPDATE_LICENSE_KEY",
    group: "geoip",
    kind: "string",
    value: "",
    secret: true,
  },
  {
    key: "config:geoip_update_interval_hours",
    env: "GEOIP_UPDATE_INTERVAL_HOURS",
    group: "geoip",
    kind: "number",
    value: 24,
  },
];

let current: Simulation | null = null;

/** The running simulation, for the shims. Null on a page without the setup demo. */
export function currentSimulation(): Simulation | null {
  return current;
}

/** Until the returned function is called. */
export function startSimulation(simulation: Simulation): () => void {
  current = simulation;
  const stopServing = serveApi((url, init) => simulation.handle(url, init));
  return () => {
    stopServing();
    if (current === simulation) current = null;
  };
}
