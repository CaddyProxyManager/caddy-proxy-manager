/**
 * The agent's environment, read once. Not the settings registry: this describes the host, not a
 * preference, and is needed before there is any database.
 */

import { resolve } from "node:path";
import type { AgentMode, CaddyBuildMode } from "@cpm/shared";
import {
  ControllerAddressError,
  checkControllerTransport,
  normalizeControllerUrl,
  normalizePairingCode,
} from "./controller-url";

export type { AgentMode };

export type AgentConfig = {
  /** Null is the idle state: the agent answers `--pair` and holds Caddy down. */
  controllerUrl: string | null;
  pairingCode: string | null;
  /** A label only: both modes dial out, and nothing listens on TCP. */
  mode: AgentMode;
  /** Where state, the socket and the shared secret live. Must be writable. */
  dataDir: string;
  /**
   * Read-only: the bootstrap token, and once on upgrade the agent database kept there before it had
   * a volume. Null reads the token from `dataDir`.
   */
  controllerDataDir: string | null;
  composeDir: string;
  /** The local control socket. The agent's only listener, and it faces the host. */
  socketPath: string;
  caddyContainerName: string;
  /** Where this host's Caddy admin API listens. The controller reaches it only through here. */
  caddyApiUrl: string;
  /** Pinned as `admin.listen` in every config forwarded to Caddy, or null to forward as sent. */
  caddyAdminListen: string | null;
  composeProject: string | null;
  /** Passed to compose as --project-directory, for a host path the agent cannot see. */
  composeHostDir: string | null;
  /** `COMPOSE_FILE`, as the operator's own compose reads it from `.env`; null for the default pair. */
  composeFiles: string[] | null;
  /** Test rigs only. */
  composeExtraFile: string | null;
  /** Test rigs only. */
  composeSkipOverride: boolean;
  /** `external`: never build Caddy's image, only load the one the operator built. */
  caddyBuildMode: CaddyBuildMode;
  buildTimeoutSeconds: number;
  /** Generous: the first start pulls the image, and a retry over a slow link only repeats. */
  serviceTimeoutSeconds: number;
  healthTimeoutSeconds: number;
  /** Dial plain http to a public controller address anyway. See `checkControllerTransport`. */
  allowInsecureHttp: boolean;
  /**
   * The one host directory certificates may be read from, as the Docker daemon sees it. Null
   * turns the feature off: the controller can only name paths inside it.
   */
  certFilesHostDir: string | null;
};

function optional(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got "${raw}"`);
  }
  return parsed;
}

function resolveMode(): AgentMode {
  const raw = optional("AGENT_MODE") ?? "standalone";
  if (raw === "standalone" || raw === "managed") return raw;
  throw new Error(`AGENT_MODE must be "standalone" or "managed"; got "${raw}".`);
}

/** External also while the controller is in offline mode: a build downloads Go modules. */
export function effectiveBuildMode(
  config: Pick<AgentConfig, "caddyBuildMode">,
  store: { controllerOffline(): boolean },
): CaddyBuildMode {
  return config.caddyBuildMode === "external" || store.controllerOffline() ? "external" : "agent";
}

function resolveBuildMode(): CaddyBuildMode {
  const raw = optional("CADDY_BUILD_MODE") ?? "agent";
  if (raw === "agent" || raw === "external") return raw;
  throw new Error(`CADDY_BUILD_MODE must be "agent" or "external"; got "${raw}".`);
}

/**
 * It becomes a `--mount` source, where a comma starts another option and a missing path is an
 * error rather than an empty directory created as root.
 */
function resolveCertFilesHostDir(): string | null {
  const raw = optional("CERT_FILES_HOST_DIR");
  if (raw === null) return null;
  const absolute = raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
  if (!absolute || /[,\r\n]/.test(raw)) {
    throw new Error(
      `CERT_FILES_HOST_DIR must be an absolute host path without commas; got "${raw}".`,
    );
  }
  return raw;
}

/** CLI flags beat the environment: fixing a bad `CONTROLLER_URL` must not need a compose edit. */
export type ConfigOverrides = {
  controllerHost?: string | null;
  controllerPort?: number | null;
  pairingCode?: string | null;
};

function flag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((optional(name) ?? "").toLowerCase());
}

/** Refuse an address the agent must not dial, and warn when it may but plain http is involved. */
function checkedUrl(url: string, allowInsecureHttp: boolean): string {
  const warning = checkControllerTransport(url, allowInsecureHttp);
  if (warning) console.warn(`[agent] ${warning}`);
  return url;
}

function resolveControllerUrl(
  overrides: ConfigOverrides,
  allowInsecureHttp: boolean,
): string | null {
  if (overrides.controllerHost) {
    return checkedUrl(
      normalizeControllerUrl(overrides.controllerHost, overrides.controllerPort ?? null),
      allowInsecureHttp,
    );
  }
  const fromEnv = optional("CONTROLLER_URL");
  if (fromEnv) {
    return checkedUrl(
      normalizeControllerUrl(fromEnv, overrides.controllerPort ?? null),
      allowInsecureHttp,
    );
  }
  // Idling silently would look like never having been configured at all.
  if (overrides.controllerPort != null) {
    throw new ControllerAddressError("--port needs --host (or CONTROLLER_URL) alongside it.");
  }
  return null;
}

function resolvePairingCode(overrides: ConfigOverrides): string | null {
  const raw = overrides.pairingCode ?? optional("PAIRING_CODE");
  return raw === null || raw === undefined ? null : normalizePairingCode(raw);
}

/**
 * Compose's own separator rule, except that a Windows host's `;` is inferred: the agent runs on
 * Linux, where Compose would default to `:` and split a `C:\` path in two.
 */
function composeFileList(): string[] | null {
  const raw = optional("COMPOSE_FILE");
  if (raw === null) return null;
  const separator = optional("COMPOSE_PATH_SEPARATOR") ?? (raw.includes(";") ? ";" : ":");
  const files = raw
    .split(separator)
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  return files.length > 0 ? files : null;
}

export function loadConfig(overrides: ConfigOverrides = {}): AgentConfig {
  const mode = resolveMode();
  const dataDir = resolve(optional("DATA_DIR") ?? "/data");
  const allowInsecureHttp = flag("CONTROLLER_ALLOW_INSECURE_HTTP");

  return {
    controllerUrl: resolveControllerUrl(overrides, allowInsecureHttp),
    allowInsecureHttp,
    pairingCode: resolvePairingCode(overrides),
    mode,
    dataDir,
    controllerDataDir: optional("CONTROLLER_DATA_DIR"),
    composeDir: resolve(optional("COMPOSE_DIR") ?? "/compose"),
    socketPath: optional("AGENT_SOCKET") ?? resolve(dataDir, "agent.sock"),
    caddyContainerName: optional("CADDY_CONTAINER_NAME") ?? "caddy-proxy-manager-caddy",
    caddyApiUrl: optional("CADDY_API_URL") ?? "http://caddy:2019",
    caddyAdminListen: optional("CADDY_ADMIN_LISTEN"),
    composeProject: optional("COMPOSE_PROJECT_NAME"),
    composeHostDir: optional("COMPOSE_HOST_DIR"),
    composeFiles: composeFileList(),
    composeExtraFile: optional("COMPOSE_EXTRA_FILE"),
    composeSkipOverride: optional("COMPOSE_SKIP_OVERRIDE") !== null,
    caddyBuildMode: resolveBuildMode(),
    buildTimeoutSeconds: positiveInteger("CADDY_BUILD_TIMEOUT", 1800),
    serviceTimeoutSeconds: positiveInteger("SERVICE_START_TIMEOUT", 900),
    healthTimeoutSeconds: positiveInteger("CADDY_HEALTH_TIMEOUT", 60),
    certFilesHostDir: resolveCertFilesHostDir(),
  };
}
