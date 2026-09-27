/**
 * Long-running operations, one at a time: overlapping recreates race for the same container with
 * each other's overrides half-written. Process-wide, as the agent is the only writer on its host.
 */

import {
  MANAGED_SERVICES,
  type ManagedServiceName,
  type ManagedServicesRequest,
} from "@cpm/shared";
import {
  BUILD_OVERRIDE_FILE,
  composeEnv,
  type DockerHost,
  invalidCaddyModule,
  invalidL4Port,
  L4_OVERRIDE_FILE,
  renderCaddyBuildOverride,
  renderL4PortsOverride,
  tail,
  writeOverride,
} from "./docker";
import type { AgentConfig } from "./config";
import type { AgentStore } from "./db";

type OperationKind = "l4-ports" | "caddy-build" | "services";

export class OperationBusyError extends Error {
  constructor(readonly running: OperationKind) {
    super(`Another operation is already running: ${running}`);
    this.name = "OperationBusyError";
  }
}

export class Operations {
  private running: OperationKind | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly store: AgentStore,
    private readonly docker: DockerHost,
  ) {}

  /** A status left mid-flight by a killed agent would spin forever, its button disabled. */
  clearStaleStatuses(): void {
    const l4 = this.store.l4PortsStatus();
    if (l4.state === "applying" || l4.state === "pending") {
      this.store.setL4PortsStatus({
        state: "failed",
        message: "The agent restarted while applying port changes. Apply again to retry.",
        error: "Interrupted by an agent restart",
      });
    }
    const build = this.store.caddyBuildStatus();
    if (build.state === "building" || build.state === "pending") {
      this.store.setCaddyBuildStatus({
        state: "failed",
        message:
          "The agent restarted while rebuilding Caddy. The image was left unchanged; rebuild to try again.",
        error: "Interrupted by an agent restart",
      });
    }
    const services = this.store.managedServicesStatus();
    if (services.state === "applying" || services.state === "pending") {
      this.store.setManagedServicesStatus({
        state: "failed",
        message:
          "The agent restarted while starting the optional services. Save the settings again to retry.",
        error: "Interrupted by an agent restart",
      });
    }
  }

  /**
   * The only thing keeping L4 routing alive across a reboot: a plain `docker compose up` omits the
   * port override. With nothing recorded Docker is adopted instead, or an empty list would
   * unpublish ports the agent never published.
   */
  async restorePublishedPorts(): Promise<void> {
    const recorded = this.store.appliedL4Ports();
    const published = await this.docker.publishedCaddyPorts();

    if (recorded.length === 0) {
      if (published.length > 0) this.store.setAppliedL4Ports(published);
      return;
    }

    // Compose's spelling on both sides, both sorted, so this compares sets.
    const same =
      recorded.length === published.length && recorded.every((port, i) => port === published[i]);
    if (same) return;

    console.log(
      `[agent] Caddy is publishing ${published.length} port(s) but ${recorded.length} were applied; republishing`,
    );
    this.applyL4Ports(recorded);
  }

  private begin(kind: OperationKind): void {
    if (this.running) throw new OperationBusyError(this.running);
    this.running = kind;
  }

  // ─── L4 ports ──────────────────────────────────────────────────────────────

  /** Returns once accepted: holding the controller's request open would time it out. */
  applyL4Ports(ports: string[]): void {
    // Refused whole: publishing the rest would report a port set nobody asked for.
    const invalid = invalidL4Port(ports);
    if (invalid !== null) {
      const error = `Invalid port mapping ${JSON.stringify(invalid)}`;
      console.warn(`[agent] refusing port change: ${error}`);
      this.store.setL4PortsStatus({
        state: "failed",
        message: `The port change was refused: ${error}. Expected HOST:CONTAINER[/tcp|/udp].`,
        triggeredAt: new Date().toISOString(),
        error,
      });
      return;
    }
    this.begin("l4-ports");
    const triggeredAt = new Date().toISOString();
    this.store.setL4PortsStatus({
      state: "applying",
      message: `Recreating Caddy with ${ports.length} published port(s).`,
      triggeredAt,
    });

    void this.runL4Ports(ports, triggeredAt).finally(() => {
      this.running = null;
    });
  }

  private async runL4Ports(ports: string[], triggeredAt: string): Promise<void> {
    try {
      writeOverride(this.config.dataDir, L4_OVERRIDE_FILE, renderL4PortsOverride(ports));

      const result = await this.docker.recreateCaddy();
      if (!result.ok) {
        const detail = tail(result.output, 5);
        this.store.setL4PortsStatus({
          state: "failed",
          message: `Could not recreate the Caddy container: ${detail}`,
          triggeredAt,
          error: detail,
        });
        return;
      }

      const health = await this.docker.waitForCaddyHealth(30);
      this.store.setAppliedL4Ports(ports);
      this.store.setL4PortsStatus({
        state: "applied",
        message:
          health === "healthy"
            ? `Caddy recreated and healthy with ${ports.length} published port(s).`
            : `Caddy recreated; its health check reports "${health}" and may still be starting.`,
        triggeredAt,
        appliedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setL4PortsStatus({
        state: "failed",
        message: `Applying port changes failed: ${message}`,
        triggeredAt,
        error: message,
      });
    }
  }

  // ─── Caddy build ───────────────────────────────────────────────────────────

  applyCaddyBuild(modules: string[]): void {
    const invalid = invalidCaddyModule(modules);
    if (invalid !== null) {
      const error = `Invalid module spec ${JSON.stringify(invalid)}`;
      console.warn(`[agent] refusing rebuild: ${error}`);
      this.store.setCaddyBuildStatus({
        state: "failed",
        message: `The rebuild was refused and the running container left untouched: ${error}.`,
        triggeredAt: new Date().toISOString(),
        error,
      });
      return;
    }
    this.begin("caddy-build");
    const triggeredAt = new Date().toISOString();
    this.store.setCaddyBuildStatus({
      state: "building",
      message: `Rebuilding the Caddy image with ${modules.length} module(s). This can take several minutes.`,
      triggeredAt,
    });

    void this.runCaddyBuild(modules, triggeredAt).finally(() => {
      this.running = null;
    });
  }

  private async runCaddyBuild(modules: string[], triggeredAt: string): Promise<void> {
    try {
      writeOverride(this.config.dataDir, BUILD_OVERRIDE_FILE, renderCaddyBuildOverride(modules));

      const build = await this.docker.buildCaddy();
      if (!build.ok) {
        // Say the old image still serves: the operator's first question is whether the proxy died.
        const detail = build.timedOut
          ? `The build was abandoned after ${this.config.buildTimeoutSeconds}s.`
          : tail(build.output, 10);
        const message = `Caddy image build failed; the running container was left untouched. ${detail}`;
        this.store.setCaddyBuildStatus({
          state: "failed",
          message,
          triggeredAt,
          error: detail,
        });
        return;
      }

      const up = await this.docker.recreateCaddy();
      if (!up.ok) {
        const detail = tail(up.output, 5);
        this.store.setCaddyBuildStatus({
          state: "failed",
          message: `Caddy was built, but recreating the container failed: ${detail}`,
          triggeredAt,
          error: detail,
        });
        return;
      }

      const health = await this.docker.waitForCaddyHealth();
      if (health !== "healthy") {
        // Usually the running config naming a plugin the new binary lacks.
        const message =
          `Caddy was rebuilt but its health check reports "${health}". Check the Caddy ` +
          `container logs - a config referencing a removed module will fail to load.`;
        this.store.setCaddyBuildStatus({
          state: "failed",
          message,
          triggeredAt,
          error: `health=${health}`,
        });
        return;
      }

      // Only now is the set in the running binary, so only now may the controller rely on it.
      this.store.setAppliedCaddyModules(modules);
      this.store.setCaddyBuildStatus({
        state: "applied",
        message: "Caddy was rebuilt with the selected modules and is healthy.",
        triggeredAt,
        appliedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setCaddyBuildStatus({
        state: "failed",
        message: `The rebuild failed: ${message}`,
        triggeredAt,
        error: message,
      });
    }
  }

  // ─── Optional services ─────────────────────────────────────────────────────

  /**
   * Reconciled every time, not diffed: after a reboot a plain `up` omits these profiles, so records
   * would lie. `up -d` and `stop` are no-ops when already in the requested state.
   */
  applyManagedServices(request: ManagedServicesRequest): void {
    this.begin("services");
    const triggeredAt = new Date().toISOString();
    const wanted = MANAGED_SERVICES.filter((name) => request.services[name]);
    this.store.setManagedServicesStatus({
      state: "applying",
      message:
        wanted.length > 0
          ? `Starting ${wanted.join(" and ")}. The first start pulls the image, which can take a few minutes.`
          : "Stopping the optional services.",
      triggeredAt,
    });

    void this.runManagedServices(request, triggeredAt).finally(() => {
      this.running = null;
    });
  }

  private async runManagedServices(
    request: ManagedServicesRequest,
    triggeredAt: string,
  ): Promise<void> {
    try {
      // To every call, `stop` included: compose interpolates the whole file, and varying these
      // makes it see an untouched service as changed.
      const env = composeEnv(request.env);

      const failures: string[] = [];
      const applied: Record<ManagedServiceName, boolean> = { clickhouse: false };

      for (const name of MANAGED_SERVICES) {
        const enable = request.services[name] === true;
        const result = enable
          ? await this.docker.startService(name, env)
          : await this.docker.stopService(name, env);

        if (result.ok) {
          applied[name] = enable;
          continue;
        }
        const detail = result.timedOut
          ? `abandoned after ${this.config.serviceTimeoutSeconds}s`
          : tail(result.output, 4);
        failures.push(`${name}: ${detail}`);
      }

      this.store.setAppliedManagedServices(applied);

      if (failures.length > 0) {
        const detail = failures.join("; ");
        this.store.setManagedServicesStatus({
          state: "failed",
          message: `Could not apply every optional service - ${detail}`,
          triggeredAt,
          error: detail,
        });
        return;
      }

      const running = MANAGED_SERVICES.filter((name) => applied[name]);
      this.store.setManagedServicesStatus({
        state: "applied",
        message:
          running.length > 0 ? `Running: ${running.join(", ")}.` : "The optional services are off.",
        triggeredAt,
        appliedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setManagedServicesStatus({
        state: "failed",
        message: `Applying the optional services failed: ${message}`,
        triggeredAt,
        error: message,
      });
    }
  }
}
