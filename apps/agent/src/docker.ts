/**
 * Everything the agent does with Docker. The controller has no socket, so whatever needs Caddy's
 * container recreated rather than reloaded - published ports, compiled-in plugins - happens here.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidL4PortMapping,
  isValidModuleSpec,
  MANAGED_SERVICE_ENV_KEYS,
  type ManagedServiceName,
  type ManagedServicesRequest,
} from "@cpm/shared";
import type { AgentConfig } from "./config";

export const L4_OVERRIDE_FILE = "docker-compose.l4-ports.yml";
export const BUILD_OVERRIDE_FILE = "docker-compose.caddy-build.yml";
/** Written by docker/caddy/Dockerfile: the CADDY_MODULES the image was built with. */
export const CADDY_MODULE_LIST_PATH = "/etc/caddy/caddy-modules.txt";

export type CommandResult = { ok: boolean; exitCode: number; output: string; timedOut: boolean };

/** One transcript for an operator: a build's cause is often on stdout, its context on stderr. */
async function run(
  argv: string[],
  options: { timeoutSeconds?: number; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const controller = new AbortController();
  const timer = options.timeoutSeconds
    ? setTimeout(() => controller.abort(), options.timeoutSeconds * 1000)
    : null;

  try {
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      // Spread: Bun replaces the environment wholesale, and `docker` needs our DOCKER_HOST.
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = [stdout, stderr].filter((s) => s.trim().length > 0).join("\n");
    return { ok: exitCode === 0, exitCode, output, timedOut: false };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, exitCode: 124, output: "", timedOut: true };
    }
    // Docker missing, or the socket unreachable. The message is the agent's own, never a remote's.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, exitCode: -1, output: message, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The last few lines of a transcript, for a status field an operator reads in a toast. */
export function tail(output: string, lines: number): string {
  return output.split("\n").slice(-lines).join("\n").trim();
}

/** A drive-letter path from a Windows compose CLI. No UNC: Docker Desktop mounts no drive then. */
const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/**
 * Where Docker Desktop exposes a Windows drive path to the daemon, or "" if it cannot tell. Raw, it
 * is "mount denied: too many colons"; omitted, relative binds mount empty directories. Only the
 * current layout: the old `/host_mnt/<letter>` is left to COMPOSE_HOST_DIR rather than guessed.
 */
export function hostPathForDaemon(label: string): string {
  const match = WINDOWS_DRIVE_PATH.exec(label.trim());
  if (!match) return "";

  const [, drive, rest] = match;
  const path = rest.replace(/\\/g, "/").replace(/\/+$/, "");
  return `/run/desktop/mnt/host/${drive.toLowerCase()}/${path}`;
}

/**
 * Stand-ins for the two variables docker-compose.yml guards with `:?`, which only web and postgres
 * read. Compose interpolates the whole file, so without them every invocation aborts; too short for
 * web to accept as a SESSION_SECRET, so one can never become a running controller's key.
 */
export const COMPOSE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  SESSION_SECRET: "unused-by-the-agent",
  POSTGRES_PASSWORD: "unused-by-the-agent",
};

export class DockerHost {
  /** Cached because it comes from a container label that cannot change without a recreate. */
  private detectedProject: string | null = null;
  /** Same, for the host path the operator's own compose was run from. "" means "asked, none found". */
  private detectedHostDir: string | null = null;

  constructor(private readonly config: AgentConfig) {}

  /**
   * One compose label off Caddy's container, "" when unreadable. Bounded: it runs before every
   * compose call, and a hung daemon would hold the operation lock; "" just means "fall back".
   */
  private async caddyLabel(label: string): Promise<string> {
    return this.containerLabel(this.config.caddyContainerName, label);
  }

  /**
   * One compose label off the agent's own container: same project as Caddy, and always running.
   * `/etc/hostname` is the container id, which the daemon accepts as a name.
   */
  private async selfLabel(label: string): Promise<string> {
    let id: string;
    try {
      id = readFileSync("/etc/hostname", "utf-8").trim();
    } catch {
      return "";
    }
    if (!id) return "";
    return this.containerLabel(id, label);
  }

  private async containerLabel(container: string, label: string): Promise<string> {
    const result = await run(
      ["docker", "inspect", "--format", `{{index .Config.Labels "${label}"}}`, container],
      { timeoutSeconds: 15 },
    );
    // `docker inspect` prints "<no value>" for a label that is not set, which is not an answer.
    const value = result.ok ? result.output.trim() : "";
    return value === "<no value>" ? "" : value;
  }

  /** Detected, not assumed: the project name comes from the directory compose was run in. */
  async composeProject(): Promise<string> {
    if (this.config.composeProject) return this.config.composeProject;
    if (this.detectedProject) return this.detectedProject;

    // Own container first: Caddy may not exist yet, since the agent is what starts it.
    const detected =
      (await this.selfLabel("com.docker.compose.project")) ||
      (await this.caddyLabel("com.docker.compose.project"));
    this.detectedProject = detected.length > 0 ? detected : "caddy-proxy-manager";
    return this.detectedProject;
  }

  /**
   * The project directory as the host knows it. Without it a relative bind resolves to a host path
   * that does not exist, and Docker silently mounts an empty directory instead of the config.
   */
  private async composeHostDir(): Promise<string> {
    if (this.config.composeHostDir) return this.config.composeHostDir;
    if (this.detectedHostDir) return this.detectedHostDir;

    // Own container first, as in composeProject. Only a real answer is cached: a cached "" let one
    // early miss poison every later invocation.
    const detected =
      (await this.selfLabel("com.docker.compose.project.working_dir")) ||
      (await this.caddyLabel("com.docker.compose.project.working_dir"));

    const usable = detected.startsWith("/") ? detected : hostPathForDaemon(detected);

    if (detected && !usable) {
      // Loud: otherwise the service starts silently without the config it mounts.
      console.warn(
        `[docker] Cannot translate the compose project directory "${detected}" into a path the ` +
          "Docker daemon can resolve. Services mounting files by relative path will come up " +
          "without them. Set COMPOSE_HOST_DIR to that directory as the daemon sees it.",
      );
    }

    if (usable) this.detectedHostDir = usable;
    return usable;
  }

  /**
   * Both overrides always: omitting either lets a rebuild drop the L4 ports, or vice versa.
   * `readsBuildContext` drops `--project-directory`: this CLI reads `context: .`, and the host path
   * does not exist here ("unable to prepare context").
   */
  private async composeArgs(readsBuildContext = false): Promise<string[]> {
    const { composeDir, composeSkipOverride, composeExtraFile, dataDir } = this.config;
    // Two independent inspects, each bounded at 15s; in series an unresponsive daemon doubled it.
    const [project, hostDir] = await Promise.all([
      this.composeProject(),
      readsBuildContext ? "" : this.composeHostDir(),
    ]);
    const args = ["-p", project];

    if (hostDir) args.push("--project-directory", hostDir);
    // Never the project's .env, which holds SESSION_SECRET and POSTGRES_PASSWORD; services get
    // their values through the agent's own environment instead.
    args.push("--env-file", "/dev/null");

    args.push("-f", join(composeDir, "docker-compose.yml"));
    const override = join(composeDir, "docker-compose.override.yml");
    if (!composeSkipOverride && existsSync(override)) args.push("-f", override);
    if (composeExtraFile && existsSync(composeExtraFile)) args.push("-f", composeExtraFile);

    if (overrideIsUsable(dataDir, BUILD_OVERRIDE_FILE)) {
      args.push("-f", join(dataDir, BUILD_OVERRIDE_FILE));
    }
    if (overrideIsUsable(dataDir, L4_OVERRIDE_FILE)) {
      args.push("-f", join(dataDir, L4_OVERRIDE_FILE));
    }

    return args;
  }

  async compose(
    argv: string[],
    options: {
      timeoutSeconds?: number;
      env?: Record<string, string>;
      readsBuildContext?: boolean;
    } = {},
  ) {
    const { readsBuildContext, ...runOptions } = options;
    return run(["docker", "compose", ...(await this.composeArgs(readsBuildContext)), ...argv], {
      ...runOptions,
      // Over process.env, so a real secret this container was handed anyway never reaches compose.
      env: { ...COMPOSE_PLACEHOLDERS, ...runOptions.env },
    });
  }

  /** Caddy logs to stderr, not a file; timestamps let a later page ask for what came since. */
  async caddyLogs(options: { since?: string | null; tail: number }): Promise<CommandResult> {
    return this.compose(
      [
        "--profile",
        "caddy",
        "logs",
        "--no-color",
        "--no-log-prefix",
        "--timestamps",
        "--tail",
        String(options.tail),
        ...(options.since ? [`--since=${options.since}`] : []),
        "caddy",
      ],
      { timeoutSeconds: 20 },
    );
  }

  /** In external mode a missing image must fail, not fall through to a build it has no grant for. */
  private noBuild(): string[] {
    return this.config.caddyBuildMode === "external" ? ["--no-build"] : [];
  }

  async recreateCaddy(): Promise<CommandResult> {
    return this.compose([
      "up",
      "-d",
      "--no-deps",
      "--pull",
      "never",
      ...this.noBuild(),
      "--force-recreate",
      "caddy",
    ]);
  }

  /**
   * The only thing that starts Caddy, so "paired" and "serving traffic" are one state. `--profile`
   * explicitly: inferring it from the service name fails on older compose v2.
   */
  async startCaddy(): Promise<CommandResult> {
    return this.compose(
      ["--profile", "caddy", "up", "-d", "--no-deps", ...this.noBuild(), "caddy"],
      { timeoutSeconds: this.config.serviceTimeoutSeconds },
    );
  }

  /** Restart Caddy in place. Its profile is named for the same reason startCaddy names it. */
  async restartCaddy(): Promise<CommandResult> {
    return this.compose(["--profile", "caddy", "restart", "caddy"], { timeoutSeconds: 120 });
  }

  /** `stop`, never `down`: unpairing must not be how someone loses their ACME account and certs. */
  async stopCaddy(timeoutSeconds = 120): Promise<CommandResult> {
    return this.compose(["--profile", "caddy", "stop", "caddy"], { timeoutSeconds });
  }

  /** Whether Caddy's container exists and is running. False for both "stopped" and "never created". */
  async caddyRunning(): Promise<boolean> {
    const result = await run([
      "docker",
      "inspect",
      "--format",
      "{{.State.Running}}",
      this.config.caddyContainerName,
    ]);
    return result.ok && result.output.trim() === "true";
  }

  /** No host project directory: the build context is read here, not by the daemon. See composeArgs. */
  async buildCaddy(): Promise<CommandResult> {
    return this.compose(["build", "caddy"], {
      timeoutSeconds: this.config.buildTimeoutSeconds,
      readsBuildContext: true,
    });
  }

  /**
   * Pulls first, for an image pushed to a registry under the same tag; a local-only tag fails the
   * pull, which is ignored. `up` recreates only when the tag now names another image.
   */
  async loadCaddyImage(): Promise<CommandResult> {
    const pull = await this.compose(
      ["--profile", "caddy", "pull", "--ignore-pull-failures", "caddy"],
      { timeoutSeconds: this.config.serviceTimeoutSeconds },
    );
    if (!pull.ok) return pull;
    return this.compose(
      ["--profile", "caddy", "up", "-d", "--no-deps", "--pull", "never", "--no-build", "caddy"],
      { timeoutSeconds: this.config.serviceTimeoutSeconds },
    );
  }

  /** The reference Caddy's container was created from, or null when there is no container. */
  async caddyImageRef(): Promise<string | null> {
    const result = await run(
      ["docker", "inspect", "--format", "{{.Config.Image}}", this.config.caddyContainerName],
      { timeoutSeconds: 15 },
    );
    const ref = result.ok ? result.output.trim() : "";
    return ref.length > 0 ? ref : null;
  }

  /**
   * The module list baked into the image Caddy runs. Copied out rather than read in a throwaway
   * container: the archive endpoint is a plain GET, and a stopped container still answers it.
   */
  async readCaddyModuleList(): Promise<CaddyModuleList> {
    const local = join(tmpdir(), `cpm-caddy-modules-${randomUUID()}.txt`);
    try {
      const copy = await run(
        ["docker", "cp", `${this.config.caddyContainerName}:${CADDY_MODULE_LIST_PATH}`, local],
        { timeoutSeconds: 30 },
      );
      if (!copy.ok) {
        return /could not find the file|no such container:path/i.test(copy.output)
          ? { state: "missing" }
          : { state: "unreadable", reason: tail(copy.output, 3) };
      }
      const modules = parseCaddyModuleList(readFileSync(local, "utf-8"));
      return modules === null
        ? { state: "unreadable", reason: `${CADDY_MODULE_LIST_PATH} is not a module list.` }
        : { state: "found", modules };
    } finally {
      rmSync(local, { force: true });
    }
  }

  /** So no caller reports success on a container that started and immediately died. */
  async waitForCaddyHealth(timeoutSeconds = this.config.healthTimeoutSeconds): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let health = "unknown";
    while (Date.now() < deadline) {
      const result = await run([
        "docker",
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        this.config.caddyContainerName,
      ]);
      health = result.ok ? result.output.trim() : "unknown";
      if (health === "healthy") return health;
      await Bun.sleep(1000);
    }
    return health;
  }

  /**
   * `--no-deps` so nothing else is recreated. No `--pull`: a profile never run has no image yet.
   * `env` goes through the child environment, not an `--env-file`: it outranks `.env`, needs no
   * quoting and stays off disk.
   */
  async startService(
    service: ManagedServiceName,
    env: Record<string, string> = {},
  ): Promise<CommandResult> {
    return this.compose(["--profile", service, "up", "-d", "--no-deps", service], {
      timeoutSeconds: this.config.serviceTimeoutSeconds,
      env,
    });
  }

  /**
   * `stop`, not `down`: turning analytics off must not delete its history. Still takes `env`:
   * compose interpolates the whole file, and an older `${VAR:?}` guard would fail here otherwise.
   */
  async stopService(
    service: ManagedServiceName,
    env: Record<string, string> = {},
  ): Promise<CommandResult> {
    return this.compose(["--profile", service, "stop", service], { timeoutSeconds: 120, env });
  }

  /** The ports Docker reports published on the running Caddy container, as compose spells them. */
  async publishedCaddyPorts(): Promise<string[]> {
    const result = await run([
      "docker",
      "inspect",
      "--format",
      "{{json .NetworkSettings.Ports}}",
      this.config.caddyContainerName,
    ]);
    if (!result.ok) return [];

    try {
      const parsed = JSON.parse(result.output.trim()) as Record<
        string,
        Array<{ HostPort?: string }> | null
      >;
      const ports = new Set<string>();
      for (const [spec, bindings] of Object.entries(parsed)) {
        if (!bindings || bindings.length === 0) continue;
        // Docker's key is "8080/tcp"; compose's short form is "8080:8080" or "53:53/udp".
        const [container, protocol] = spec.split("/");
        for (const binding of bindings) {
          if (!binding.HostPort) continue;
          ports.add(`${binding.HostPort}:${container}${protocol === "udp" ? "/udp" : ""}`);
        }
      }
      return Array.from(ports).sort();
    } catch {
      return [];
    }
  }

  /**
   * Caddy's storage is readable only by Caddy's user, hence a throwaway container of its image.
   * Created, started and read back rather than `docker run`, whose attach endpoint the socket proxy
   * doesn't open - as validateCaddyConfig does.
   */
  async runInCaddyStorage(argv: string[], timeoutSeconds = 30): Promise<CommandResult> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const remaining = () => Math.max(1, Math.round((deadline - Date.now()) / 1000));
    const caddy = this.config.caddyContainerName;
    const image = await run(["docker", "inspect", "--format", "{{.Image}}", caddy], {
      timeoutSeconds: 15,
    });
    if (!image.ok || !image.output.trim().startsWith("sha256:")) {
      return {
        ok: false,
        exitCode: -1,
        output: "Caddy's container does not exist yet.",
        timedOut: false,
      };
    }
    const name = `cpm-caddy-storage-${randomUUID()}`;
    try {
      const create = await run(
        [
          "docker",
          "create",
          "--name",
          name,
          "--label",
          "cpm.caddy-storage=1",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--volumes-from",
          `${caddy}:ro`,
          "--entrypoint",
          argv[0],
          image.output.trim(),
          ...argv.slice(1),
        ],
        { timeoutSeconds: remaining() },
      );
      if (!create.ok) return create;
      const start = await run(["docker", "start", name], { timeoutSeconds: remaining() });
      if (!start.ok) return start;
      const wait = await run(["docker", "wait", name], { timeoutSeconds: remaining() });
      if (!wait.ok) return wait;
      const logs = await run(["docker", "logs", name], { timeoutSeconds: remaining() });
      return { ...logs, ok: logs.ok && wait.output.trim() === "0" };
    } finally {
      await run(["docker", "rm", "--force", name], { timeoutSeconds: 15 });
    }
  }

  /**
   * `caddy validate` in a throwaway, network-less container of Caddy's own image, so its modules
   * count. No exec grant and no mount, so the config is copied in; the image's user stays because
   * Coraza opens the caddy-owned audit log while building a WAF.
   */
  async validateCaddyConfig(config: string, timeoutSeconds = 45): Promise<CaddyValidation> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const remaining = () => Math.max(1, Math.round((deadline - Date.now()) / 1000));

    const image = await run(
      ["docker", "inspect", "--format", "{{.Image}}", this.config.caddyContainerName],
      { timeoutSeconds: 15 },
    );
    if (!image.ok || !image.output.trim().startsWith("sha256:")) {
      return { state: "unavailable", reason: "Caddy's container does not exist yet." };
    }

    const id = randomUUID();
    const name = `cpm-caddy-validate-${id}`;
    const local = join(tmpdir(), `${name}.json`);
    writeFileSync(local, config, { mode: 0o644 });
    try {
      const create = await run(
        [
          "docker",
          "create",
          "--name",
          name,
          "--label",
          "cpm.caddy-validate=1",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          // The image's caddy carries it as a file capability, and exec fails without it.
          "--cap-add",
          "NET_BIND_SERVICE",
          "--security-opt",
          "no-new-privileges",
          // `docker logs` below needs a driver it can read back, whatever the daemon defaults to.
          "--log-driver",
          "json-file",
          "--entrypoint",
          "caddy",
          image.output.trim(),
          "validate",
          "--config",
          VALIDATE_CONFIG_PATH,
        ],
        { timeoutSeconds: remaining() },
      );
      if (!create.ok) return { state: "unavailable", reason: tail(create.output, 3) };

      // Started and waited on rather than `docker run`: attaching is a hijacked connection, which
      // the socket proxy's HTTP mode is not trusted to pass.
      for (const argv of [
        ["docker", "cp", local, `${name}:${VALIDATE_CONFIG_PATH}`],
        ["docker", "start", name],
      ]) {
        const step = await run(argv, { timeoutSeconds: remaining() });
        if (!step.ok) return { state: "unavailable", reason: tail(step.output, 3) };
      }
      const wait = await run(["docker", "wait", name], { timeoutSeconds: remaining() });
      if (!wait.ok) {
        return {
          state: "unavailable",
          reason: wait.timedOut ? "caddy validate did not finish in time." : tail(wait.output, 3),
        };
      }
      const accepted = wait.output.trim() === "0";
      const logs = await run(["docker", "logs", name], { timeoutSeconds: remaining() });
      // An acceptance is the exit code alone. A refusal is only worth reporting with Caddy's
      // reason: without it the output would be the daemon's error, read as Caddy's.
      if (!logs.ok && !accepted) {
        return {
          state: "unavailable",
          reason: logs.timedOut ? "docker logs did not finish in time." : tail(logs.output, 3),
        };
      }
      const output = logs.ok ? tail(logs.output, VALIDATE_TRANSCRIPT_LINES) : "";
      return { state: accepted ? "accepted" : "refused", output };
    } finally {
      rmSync(local, { force: true });
      // Also after a timeout, when the container may still be running.
      await run(["docker", "rm", "--force", name], { timeoutSeconds: 15 });
    }
  }
}

export type CaddyModuleList =
  | { state: "found"; modules: string[] }
  /** An image not built from docker/caddy/Dockerfile: nothing says what it carries. */
  | { state: "missing" }
  | { state: "unreadable"; reason: string };

/** Whitespace-separated, as the Dockerfile writes CADDY_MODULES; null if any entry is not a spec. */
export function parseCaddyModuleList(contents: string): string[] | null {
  if (contents.length > 256 * 1024) return null;
  const modules = contents.split(/\s+/).filter(Boolean);
  if (modules.length > 1024) return null;
  return invalidCaddyModule(modules) === null ? modules : null;
}

/** Where the copied config sits in the validation container. /tmp is writable in any image. */
const VALIDATE_CONFIG_PATH = "/tmp/cpm-validate.json";

/** Caddy logs a line per module it provisions; the refusal is the last. */
const VALIDATE_TRANSCRIPT_LINES = 40;

export type CaddyValidation =
  | { state: "accepted" | "refused"; output: string }
  /** Nothing was learned about the config: there was no Caddy to ask, or asking failed. */
  | { state: "unavailable"; reason: string };

// ─── Generated compose files ─────────────────────────────────────────────────

/**
 * A YAML double-quoted scalar. JSON's string syntax is a subset of it, so no value - validated or
 * not - can close the quote and add keys to the service.
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderL4PortsOverride(ports: string[]): string {
  if (ports.length === 0) {
    return `# Generated by the Caddy Proxy Manager agent - L4 port mappings
# No L4 proxy host requires an additional published port.
services: {}
`;
  }
  const lines = ports.map((port) => `      - ${yamlString(port)}`).join("\n");
  return `# Generated by the Caddy Proxy Manager agent - L4 port mappings
# Do not edit: rewritten whenever the controller applies a port change.
services:
  caddy:
    ports:
${lines}
`;
}

export function renderCaddyBuildOverride(modules: string[]): string {
  return `# Generated by the Caddy Proxy Manager agent - Caddy module selection
# Do not edit: rewritten whenever the controller requests a rebuild.
services:
  caddy:
    build:
      args:
        CADDY_MODULES: ${yamlString(modules.join(" "))}
`;
}

export function writeOverride(dataDir: string, file: string, contents: string): void {
  writeFileSync(join(dataDir, file), contents, "utf-8");
}

/** The first entry that is not a valid port mapping, or null when all are. */
export function invalidL4Port(ports: unknown): string | null {
  if (!Array.isArray(ports)) return String(ports);
  for (const port of ports) {
    if (typeof port !== "string" || !isValidL4PortMapping(port)) return String(port);
  }
  return null;
}

/** The first entry that is not a valid xcaddy `--with` spec, or null when all are. */
export function invalidCaddyModule(modules: unknown): string | null {
  if (!Array.isArray(modules)) return String(modules);
  for (const spec of modules) {
    if (typeof spec !== "string" || !isValidModuleSpec(spec)) return String(spec);
  }
  return null;
}

/**
 * Recover the entries an override file was rendered from, or null if it is not exactly what the
 * renderer would write for valid entries. A file from an older agent, or one written before
 * validation existed, is otherwise included in every compose invocation for good.
 */
function parseOverride(file: string, contents: string): string[] | null {
  const lines = contents.split("\n");
  let entries: string[];
  try {
    if (file === L4_OVERRIDE_FILE) {
      entries = lines
        .filter((line) => line.startsWith("      - "))
        .map((line) => JSON.parse(line.slice("      - ".length)) as string);
      if (invalidL4Port(entries) !== null) return null;
      return renderL4PortsOverride(entries) === contents ? entries : null;
    }
    const prefix = "        CADDY_MODULES: ";
    const line = lines.find((l) => l.startsWith(prefix));
    if (line === undefined) return null;
    const joined = JSON.parse(line.slice(prefix.length)) as unknown;
    if (typeof joined !== "string") return null;
    entries = joined.split(" ").filter((spec) => spec.length > 0);
    if (invalidCaddyModule(entries) !== null) return null;
    return renderCaddyBuildOverride(entries) === contents ? entries : null;
  } catch {
    return null;
  }
}

/**
 * Whether a generated override may be handed to compose. One that fails to round-trip is removed:
 * the next desired-state frame, or the startup port restore, writes a fresh one.
 */
export function overrideIsUsable(dataDir: string, file: string): boolean {
  const path = join(dataDir, file);
  if (!existsSync(path)) return false;
  let contents: string;
  try {
    contents = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  if (parseOverride(file, contents) !== null) return true;
  console.warn(`[docker] ${file} is not one this agent would have written; removing it`);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.warn(`[docker] could not remove ${file}:`, error);
  }
  return false;
}

/**
 * Only MANAGED_SERVICE_ENV_KEYS pass: this reaches a `docker` holding the socket, where DOCKER_HOST
 * or LD_PRELOAD would hand over the host. Unset entries fall back to the agent's own environment.
 */
export function composeEnv(env: ManagedServicesRequest["env"] | undefined): Record<string, string> {
  const allowed = MANAGED_SERVICE_ENV_KEYS as readonly string[];
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!allowed.includes(key)) {
      console.warn(`[docker] ignoring ${JSON.stringify(key)}: not a managed service variable`);
      continue;
    }
    if (typeof value !== "string" || value.length === 0) continue;
    // Thrown rather than dropped, so the operation reports it. Names the key, never the value.
    if (/[\n\r\0]/.test(value)) {
      throw new Error(`${key} contains a line break or NUL, which compose cannot be given safely`);
    }
    result[key] = value;
  }
  return result;
}
