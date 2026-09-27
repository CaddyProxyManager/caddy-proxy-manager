/**
 * Everything the agent does with Docker.
 *
 * This is the whole reason the agent exists as a separate container: the controller has no Docker
 * socket, and anything needing the Caddy *container* recreated - rather than its config reloaded
 * over the admin API - has to happen here. Two such things: published ports, which are fixed at
 * create time, and compiled-in plugins.
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

/** Files the agent generates for compose. Written by the agent now, not the controller. */
export const L4_OVERRIDE_FILE = "docker-compose.l4-ports.yml";
export const BUILD_OVERRIDE_FILE = "docker-compose.caddy-build.yml";

export type CommandResult = { ok: boolean; exitCode: number; output: string; timedOut: boolean };

/**
 * Run a command, capturing both streams as one transcript.
 *
 * Interleaved rather than separated because that transcript exists to be shown to an operator, and
 * a build failure's cause is routinely on stdout with the exit context on stderr.
 */
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
      // Spread, because Bun replaces the environment wholesale rather than extending it - and
      // `docker` needs DOCKER_HOST from ours to find the socket proxy at all.
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

/**
 * A drive-letter path, as recorded by a compose CLI running on Windows.
 *
 * Anchored and case-insensitive on the letter; a UNC path (`\\server\share`) deliberately does
 * not match, because there is no drive for Docker Desktop to have mounted.
 */
const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/**
 * Where Docker Desktop exposes a Windows path to the daemon, or "" if it cannot be worked out.
 *
 * The agent runs a Linux `docker compose` against the host's daemon, and hands it
 * `--project-directory` so relative bind mounts resolve somewhere the *daemon* can find. On a
 * Linux host the label is already such a path. On Docker Desktop for Windows it is a drive path,
 * which is not a path at all as far as the daemon is concerned: passing it raw produces
 * "mount denied: too many colons", and passing nothing leaves `./docker/...` resolving against the
 * agent's own `/compose`, where the daemon silently creates an empty directory instead.
 *
 * Docker Desktop mounts each shared drive inside its VM at `/run/desktop/mnt/host/<letter>`, so
 * `C:\\deploy\\cpm` is `/run/desktop/mnt/host/c/deploy/cpm`. Verified against Docker Desktop
 * 29.7: a bind resolved through this prefix mounts the real file, where the untranslated form
 * mounts an empty directory.
 *
 * Only the current layout is produced. Docker Desktop used `/host_mnt/<letter>` years ago, and
 * guessing between the two would be wrong half the time on deployments that still have it;
 * COMPOSE_HOST_DIR is the answer there, and the caller says so when this returns "".
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
   * Read one compose label off the running Caddy container. Empty when it cannot be read.
   *
   * Bounded, unlike most inspects: this runs before every compose invocation, and an unresponsive
   * daemon would otherwise hold the operation lock with no timeout to end it. Both callers treat
   * an empty answer as "fall back", so giving up early costs nothing.
   */
  private async caddyLabel(label: string): Promise<string> {
    return this.containerLabel(this.config.caddyContainerName, label);
  }

  /**
   * One compose label off this agent's own container.
   *
   * The agent is a service in the same project, so it carries the same project name and working
   * directory as everything else - and unlike Caddy it is, by definition, running whenever this
   * code executes. `/etc/hostname` is the container id inside the container, which is what the
   * daemon accepts in place of a name.
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

  /**
   * The compose project to operate on, read off the running Caddy container's labels.
   *
   * Detected rather than assumed: the project name comes from the directory the operator ran
   * `docker compose up` in, so hard-coding it would make the agent silently manage a project that
   * does not exist on any deployment whose directory is not called `caddy-proxy-manager`.
   */
  async composeProject(): Promise<string> {
    if (this.config.composeProject) return this.config.composeProject;
    if (this.detectedProject) return this.detectedProject;

    // This agent's own container first: Caddy may not exist yet - the agent is what starts it -
    // and asking a container that is not there returns nothing at all.
    const detected =
      (await this.selfLabel("com.docker.compose.project")) ||
      (await this.caddyLabel("com.docker.compose.project"));
    this.detectedProject = detected.length > 0 ? detected : "caddy-proxy-manager";
    return this.detectedProject;
  }

  /**
   * The project directory as the *host* knows it, for `--project-directory`.
   *
   * The daemon resolves a relative bind mount against the project directory, and `/compose` is a
   * path inside this container. Left unset, `./docker/clickhouse/low-disk-write.yml` resolves to a
   * host path that does not exist, and Docker silently creates an empty directory there - so the
   * service comes up without the config it was mounted, which is a wrong container rather than a
   * failed command.
   *
   * Caddy uses named volumes only, so this went unnoticed while recreating it was all the agent
   * did. Detected from the same container's labels as the project name, for the same reason:
   * asking the operator to set `COMPOSE_HOST_DIR` correctly is not a thing to depend on.
   */
  private async composeHostDir(): Promise<string> {
    if (this.config.composeHostDir) return this.config.composeHostDir;
    if (this.detectedHostDir) return this.detectedHostDir;

    // Own container first, for the reason in composeProject: the first thing the agent brings up
    // may be a managed service rather than Caddy, and reading Caddy's labels before Caddy exists
    // answers "" - which meant no --project-directory and every relative bind resolving against a
    // path only this container has. ClickHouse came up with an empty directory where its config
    // should have been, which is a wrong container rather than a failed command.
    //
    // Only a real answer is cached. Caching "" meant one early miss poisoned every later
    // invocation for the life of the process, long after Caddy was up and could have answered.
    const detected =
      (await this.selfLabel("com.docker.compose.project.working_dir")) ||
      (await this.caddyLabel("com.docker.compose.project.working_dir"));

    // A POSIX path is already what the daemon wants. A Windows one is not, and passing it raw
    // turns every invocation into "mount denied: too many colons" - see hostPathForDaemon, which
    // translates it into the path Docker Desktop exposes the drive at instead.
    const usable = detected.startsWith("/") ? detected : hostPathForDaemon(detected);

    if (detected && !usable) {
      // Loud, because the alternative is a container that comes up wrong. Without a project
      // directory the daemon resolves `./docker/...` against a path only this container has, and
      // silently creates an empty directory there - the service starts, without the configuration
      // it was supposed to be given.
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
   * The -f/-p/--env-file arguments every invocation shares.
   *
   * Both overrides are always included: a rebuild must not drop the published L4 ports, and a port
   * change must not rebuild Caddy without the module selection. Omitting either is how one
   * operation silently undoes the other.
   *
   * `readsBuildContext` drops `--project-directory`: the daemon resolves bind mounts, but the CLI in
   * this container reads `context: .`, and the host path does not exist here - so a build against it
   * fails with "unable to prepare context". Compose then anchors to the first -f file, in COMPOSE_DIR.
   */
  private async composeArgs(readsBuildContext = false): Promise<string[]> {
    const { composeDir, composeSkipOverride, composeExtraFile, dataDir } = this.config;
    // Two independent inspects, each bounded at 15s; in series an unresponsive daemon doubled it.
    const [project, hostDir] = await Promise.all([
      this.composeProject(),
      readsBuildContext ? "" : this.composeHostDir(),
    ]);
    const args = ["-p", project];

    // The daemon resolves relative bind-mount paths against the project directory, and the agent's
    // /compose mount is not where the host thinks the project is. See composeHostDir.
    if (hostDir) args.push("--project-directory", hostDir);
    // Never the project's .env: it holds SESSION_SECRET and POSTGRES_PASSWORD, which this container
    // must not read. An explicit empty file stops compose finding one on its own. What the services
    // the agent runs interpolate reaches it through its own environment (docker-compose.yml).
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

  /** Recreate only the Caddy container, leaving everything else running. */
  async recreateCaddy(): Promise<CommandResult> {
    return this.compose(["up", "-d", "--no-deps", "--pull", "never", "--force-recreate", "caddy"]);
  }

  /**
   * Bring Caddy up, enabling its profile for this invocation.
   *
   * Caddy sits behind a compose profile so that `docker compose up` does not start it: an agent
   * with no controller has no configuration to serve, and a Caddy answering on 80 and 443 with a
   * default page is worse than one that is not listening at all. This is the only thing that
   * starts it, which is what makes "paired" and "serving traffic" the same state.
   *
   * `--profile` explicitly rather than relying on compose to infer it from the service name, for
   * the same reason startService does: that inference is a "no such service" error on older v2.
   */
  async startCaddy(): Promise<CommandResult> {
    return this.compose(["--profile", "caddy", "up", "-d", "--no-deps", "caddy"], {
      timeoutSeconds: this.config.serviceTimeoutSeconds,
    });
  }

  /** Restart Caddy in place. Its profile is named for the same reason startCaddy names it. */
  async restartCaddy(): Promise<CommandResult> {
    return this.compose(["--profile", "caddy", "restart", "caddy"], { timeoutSeconds: 120 });
  }

  /**
   * Stop Caddy, leaving its container, certificates and config volumes in place.
   *
   * `stop`, never `down`: an agent that was unpaired must not be how someone discovers their ACME
   * account and issued certificates are gone.
   */
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
   * Poll the Caddy healthcheck until it passes or the budget runs out, returning the last status
   * seen. Both the port apply and the rebuild ask the same question - did it come back up - so
   * neither reports success on a container that started and immediately died.
   */
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
   * Bring one optional service up, enabling its profile for this invocation.
   *
   * `--profile` rather than relying on compose auto-enabling the profile of a service named on the
   * command line: that behaviour arrived partway through v2 and is silently a "no such service"
   * error on anything older. `--no-deps` because these have no dependency the stack is not already
   * running, and pulling in the rest would recreate containers nobody asked to touch.
   *
   * No `--pull` flag, unlike recreateCaddy: a deployment that never ran the profile has no image
   * for it, so the implicit pull-if-missing is exactly what is wanted - and also why this takes a
   * timeout measured in minutes.
   *
   * `env` carries the credentials the compose file interpolates. Passed through the child's
   * environment rather than a generated `--env-file`, for two reasons: compose reads the process
   * environment at a higher precedence than any env file, so this overrides a stale value in the
   * project's own `.env` without the agent needing to write to a read-only mount - and a value
   * passed this way needs no quoting, where an env file would need escaping that compose's parser
   * defines differently for single and double quotes. It also keeps the password off disk.
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
   * Stop one optional service, leaving its container and volume in place.
   *
   * `stop` rather than `down` or `rm`: turning analytics off must not be how someone discovers
   * their event history is gone. The data volume outlives the toggle.
   *
   * Still takes `env`, so every invocation resolves the project to the same configuration. Compose
   * interpolates the whole file before deciding what to act on, and a deployment whose compose file
   * still guards a credential with `${VAR:?}` - an override, or one shipped before this - would
   * otherwise fail here on a variable belonging to a service this command is not touching.
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
   * `caddy validate` on a config, run by the binary this host's Caddy runs, without loading it.
   *
   * A throwaway container from the Caddy container's own image, so a rebuilt Caddy validates with
   * its own modules. The socket proxy grants no exec, and a mount would hand the image this agent's
   * data volume, so the config is copied into the created container before it starts. It keeps
   * the image's user because Coraza opens the audit log, caddy-owned in the image, while building a
   * WAF. No network: whatever the config says, it can reach nothing.
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
 * The child environment for a managed-service invocation.
 *
 * Only MANAGED_SERVICE_ENV_KEYS pass: every entry lands in the environment of a `docker` that
 * holds the socket, where DOCKER_HOST, PATH or LD_PRELOAD would hand over the host. Unset entries
 * are dropped so compose falls back to the agent's own environment; it never reads `.env`.
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
