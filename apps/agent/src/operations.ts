/**
 * Long-running operations, one at a time: overlapping recreates race for the same container with
 * each other's overrides half-written. Process-wide, as the agent is the only writer on its host.
 */

import {
  type AgentStatusMessageCode,
  type AgentStatusMessageParams,
  MANAGED_SERVICES,
  type ManagedServiceName,
  type ManagedServicesRequest,
  SHIPPED_CADDY_MODULES,
  expandL4PortMappings,
} from "@cpm/shared";
import {
  BUILD_OVERRIDE_FILE,
  CADDY_MODULE_LIST_PATH,
  type CaddyModuleList,
  composeEnv,
  type DockerHost,
  invalidCaddyModule,
  invalidL4Port,
  isMissingComposeService,
  L4_OVERRIDE_FILE,
  managedServicesEnvFingerprint,
  renderCaddyBuildOverride,
  renderL4PortsOverride,
  tail,
  writeOverride,
} from "./docker";
import type { AgentConfig } from "./config";
import type { AgentStore } from "./db";

type OperationKind = "l4-ports" | "caddy-build" | "services";

type Said = {
  message: string;
  messageCode: AgentStatusMessageCode;
  messageParams?: AgentStatusMessageParams;
};

/** `message` is the English an older controller shows; a newer one words the code itself. */
function said(
  code: AgentStatusMessageCode,
  message: string,
  params?: AgentStatusMessageParams,
): Said {
  return params
    ? { message, messageCode: code, messageParams: params }
    : { message, messageCode: code };
}

export class OperationBusyError extends Error {
  constructor(readonly running: OperationKind) {
    super(`Another operation is already running: ${running}`);
    this.name = "OperationBusyError";
  }
}

export class Operations {
  private running: OperationKind | null = null;
  private idleListeners: Array<() => void> = [];

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
        ...said(
          "l4Interrupted",
          "The agent restarted while applying port changes. Apply again to retry.",
        ),
        error: "Interrupted by an agent restart",
      });
    }
    const build = this.store.caddyBuildStatus();
    if (build.state === "building" || build.state === "pending") {
      this.store.setCaddyBuildStatus({
        state: "failed",
        ...said(
          "buildInterrupted",
          "The agent restarted while rebuilding Caddy. The image was left unchanged; rebuild to try again.",
        ),
        error: "Interrupted by an agent restart",
      });
    }
    const services = this.store.managedServicesStatus();
    if (services.state === "applying" || services.state === "pending") {
      this.store.setManagedServicesStatus({
        state: "failed",
        ...said(
          "servicesInterrupted",
          "The agent restarted while starting the optional services. Save the settings again to retry.",
        ),
        error: "Interrupted by an agent restart",
      });
    }
  }

  /**
   * The only thing keeping L4 routing alive across a reboot: a plain `docker compose up` omits the
   * port override. Nothing recorded is nothing to restore. Adopting what Docker publishes instead
   * recorded 80 and 443 as applied, and the first desired state then recreated Caddy to drop them.
   */
  async restorePublishedPorts(): Promise<void> {
    const recorded = this.store.appliedL4Ports();
    if (recorded.length === 0) return;
    const published = await this.docker.publishedCaddyPorts();

    // Docker lists a published range port by port, so the recorded ranges are expanded to match.
    // Contained, not equal: Caddy also publishes 80 and 443 from the base file, which no apply
    // records, so an equal set never matched and every agent start recreated Caddy.
    const live = new Set(expandL4PortMappings(published));
    const missing = expandL4PortMappings(recorded).filter((port) => !live.has(port));
    if (missing.length === 0) return;

    console.log(
      `[agent] Caddy is not publishing ${missing.length} of the port(s) applied; republishing`,
    );
    this.applyL4Ports(recorded);
  }

  private begin(kind: OperationKind): void {
    if (this.running) throw new OperationBusyError(this.running);
    this.running = kind;
  }

  private end(): void {
    this.running = null;
    for (const listener of this.idleListeners.splice(0)) listener();
  }

  /** Called once nothing runs: at once if nothing does, else when the running operation ends. */
  whenIdle(listener: () => void): void {
    if (this.running) this.idleListeners.push(listener);
    else listener();
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
        ...said(
          "l4Refused",
          `The port change was refused: ${error}. Expected HOST:CONTAINER[/tcp|/udp], each side a port or an A-B range.`,
          { error },
        ),
        triggeredAt: new Date().toISOString(),
        error,
      });
      return;
    }
    this.begin("l4-ports");
    const triggeredAt = new Date().toISOString();
    this.store.setL4PortsStatus({
      state: "applying",
      ...said(
        "l4Applying",
        `Recreating Caddy with ${expandL4PortMappings(ports).length} published port(s).`,
        { count: expandL4PortMappings(ports).length },
      ),
      triggeredAt,
    });

    void this.runL4Ports(ports, triggeredAt).finally(() => this.end());
  }

  private async runL4Ports(ports: string[], triggeredAt: string): Promise<void> {
    try {
      writeOverride(this.config.dataDir, L4_OVERRIDE_FILE, renderL4PortsOverride(ports));

      const result = await this.docker.recreateCaddy();
      if (!result.ok) {
        const detail = tail(result.output, 5);
        this.store.setL4PortsStatus({
          state: "failed",
          ...said("l4RecreateFailed", `Could not recreate the Caddy container: ${detail}`, {
            detail,
          }),
          triggeredAt,
          error: detail,
        });
        return;
      }

      const health = await this.docker.waitForCaddyHealth(30);
      this.store.setAppliedL4Ports(ports);
      this.store.setL4PortsStatus({
        state: "applied",
        ...(health === "healthy"
          ? said(
              "l4AppliedHealthy",
              `Caddy recreated and healthy with ${expandL4PortMappings(ports).length} published port(s).`,
              { count: expandL4PortMappings(ports).length },
            )
          : said(
              "l4AppliedStarting",
              `Caddy recreated; its health check reports "${health}" and may still be starting.`,
              { health },
            )),
        triggeredAt,
        appliedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setL4PortsStatus({
        state: "failed",
        ...said("l4Failed", `Applying port changes failed: ${message}`, { detail: message }),
        triggeredAt,
        error: message,
      });
    }
  }

  // ─── Caddy build ───────────────────────────────────────────────────────────

  /**
   * External mode's "applied": what the image Caddy runs says it carries. One with no list counts
   * as no plugins, which only costs features; assuming the catalog could fail every config load.
   */
  async syncModulesFromImage(): Promise<CaddyModuleList> {
    const list = await this.docker.readCaddyModuleList();
    if (list.state === "unreadable") return list;
    this.store.setAppliedCaddyModules(list.state === "found" ? list.modules : []);
    const image = await this.docker.caddyImageRef();
    if (image) this.store.setCaddyImage(image);
    return list;
  }

  /**
   * External mode's rebuild: load whatever the operator built under Caddy's image reference.
   * Throws when busy before it returns; the promise settles when the load does. `narrowed` runs
   * when the new image drops modules Caddy has now, and resolves once the controller has loaded a
   * config without them: `caddy run --resume` exits on an autosave naming a missing module.
   */
  loadCaddyImage(narrowed: () => Promise<boolean> = async () => false): Promise<void> {
    this.begin("caddy-build");
    const triggeredAt = new Date().toISOString();
    this.store.setCaddyBuildStatus({
      state: "building",
      ...said("imageLoading", "Loading the Caddy image you built."),
      triggeredAt,
    });
    return this.runCaddyImageLoad(triggeredAt, narrowed).finally(() => this.end());
  }

  private async runCaddyImageLoad(
    triggeredAt: string,
    narrowed: () => Promise<boolean>,
  ): Promise<void> {
    const failed = (message: Said, error: string) =>
      this.store.setCaddyBuildStatus({ state: "failed", ...message, triggeredAt, error });
    const untouched = (code: AgentStatusMessageCode, step: string, detail: string) =>
      failed(
        said(code, `${step}; the running container was left untouched. ${detail}`, { detail }),
        detail,
      );
    try {
      const pull = await this.docker.pullCaddyImage();
      if (!pull.ok) {
        return untouched("imagePullFailed", "Pulling the Caddy image failed", tail(pull.output, 5));
      }

      const image = await this.docker.composeCaddyImage();
      const incoming = image
        ? await this.docker.readImageModuleList(image)
        : ({ state: "unreadable", reason: "compose names no image for caddy." } as const);
      if (incoming.state === "unreadable") {
        return untouched(
          "imageModulesUnreadable",
          "The new image's module list could not be read",
          incoming.reason,
        );
      }
      const next = incoming.state === "found" ? incoming.modules : [];
      const current = this.store.appliedCaddyModules() ?? [...SHIPPED_CADDY_MODULES];
      const kept = current.filter((module) => next.includes(module));
      if (kept.length < current.length) {
        this.store.setAppliedCaddyModules(kept);
        this.store.setCaddyBuildStatus({
          state: "building",
          ...said(
            "imageNarrowing",
            "Waiting for the controller to stop using modules the new image lacks.",
          ),
          triggeredAt,
        });
        // Timed out, the recreate is still tried: the old config may not use what was dropped.
        if (!(await narrowed())) {
          console.warn("[agent] no narrowed config arrived before recreating Caddy");
        }
      }

      const up = await this.docker.upCaddyImage();
      if (!up.ok) {
        return untouched(
          "imageRecreateFailed",
          "Recreating Caddy on the new image failed",
          tail(up.output, 5),
        );
      }

      // Before the health wait: a binary missing a module the running config names never turns
      // healthy, and the controller has to stop emitting that module either way.
      const list = await this.syncModulesFromImage();
      if (list.state === "unreadable") {
        failed(
          said(
            "imageModulesUnreadableAfter",
            `Caddy was recreated, but its module list could not be read: ${list.reason}`,
            { detail: list.reason },
          ),
          list.reason,
        );
        return;
      }

      const health = await this.docker.waitForCaddyHealth();
      if (health !== "healthy") {
        failed(
          said(
            "imageUnhealthy",
            `Caddy's health check reports "${health}" on the new image. Check the Caddy container ` +
              "logs: a config that uses a module the image lacks fails to load.",
            { health },
          ),
          `health=${health}`,
        );
        return;
      }

      const loadedRef = this.store.caddyImage() ?? "";
      const loaded = loadedRef || "the image";
      this.store.setCaddyBuildStatus({
        state: "applied",
        ...(list.state === "found"
          ? said("imageLoaded", `Loaded ${loaded} with ${list.modules.length} module(s).`, {
              image: loadedRef,
              named: loadedRef ? "yes" : "no",
              count: list.modules.length,
            })
          : said(
              "imageLoadedNoList",
              `Loaded ${loaded}, which has no ${CADDY_MODULE_LIST_PATH}, so it is treated as having no plugins. Build it from docker/caddy/Dockerfile.`,
              { image: loadedRef, named: loadedRef ? "yes" : "no", path: CADDY_MODULE_LIST_PATH },
            )),
        triggeredAt,
        appliedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed(
        said("imageLoadFailed", `Loading the Caddy image failed: ${message}`, { detail: message }),
        message,
      );
    }
  }

  applyCaddyBuild(modules: string[]): void {
    const invalid = invalidCaddyModule(modules);
    if (invalid !== null) {
      const error = `Invalid module spec ${JSON.stringify(invalid)}`;
      console.warn(`[agent] refusing rebuild: ${error}`);
      this.store.setCaddyBuildStatus({
        state: "failed",
        ...said(
          "buildRefused",
          `The rebuild was refused and the running container left untouched: ${error}.`,
          { error },
        ),
        triggeredAt: new Date().toISOString(),
        error,
      });
      return;
    }
    this.begin("caddy-build");
    const triggeredAt = new Date().toISOString();
    this.store.setCaddyBuildStatus({
      state: "building",
      ...said(
        "building",
        `Rebuilding the Caddy image with ${modules.length} module(s). This can take several minutes.`,
        { count: modules.length },
      ),
      triggeredAt,
    });

    void this.runCaddyBuild(modules, triggeredAt).finally(() => this.end());
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
          ...(build.timedOut
            ? said("buildTimedOut", message, { seconds: this.config.buildTimeoutSeconds })
            : said("buildFailedOutput", message, { detail })),
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
          ...said(
            "buildRecreateFailed",
            `Caddy was built, but recreating the container failed: ${detail}`,
            { detail },
          ),
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
          `container logs: a config that uses a removed module fails to load.`;
        this.store.setCaddyBuildStatus({
          state: "failed",
          ...said("buildUnhealthy", message, { health }),
          triggeredAt,
          error: `health=${health}`,
        });
        return;
      }

      // Only now is the set in the running binary, so only now may the controller rely on it.
      this.store.setAppliedCaddyModules(modules);
      this.store.setCaddyBuildStatus({
        state: "applied",
        ...said("buildApplied", "Caddy was rebuilt with the selected modules and is healthy."),
        triggeredAt,
        appliedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setCaddyBuildStatus({
        state: "failed",
        ...said("buildFailed", `The rebuild failed: ${message}`, { detail: message }),
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
      ...(wanted.length > 0
        ? said(
            "servicesStarting",
            `Starting ${wanted.join(" and ")}. The first start pulls the image, which can take a few minutes.`,
            { services: wanted.join(", ") },
          )
        : said("servicesStopping", "Stopping the optional services.")),
      triggeredAt,
    });

    void this.runManagedServices(request, triggeredAt).finally(() => this.end());
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
      const applied = Object.fromEntries(MANAGED_SERVICES.map((name) => [name, false])) as Record<
        ManagedServiceName,
        boolean
      >;

      for (const name of MANAGED_SERVICES) {
        const enable = request.services[name] === true;
        const result = enable
          ? await this.docker.startService(name, env)
          : await this.docker.stopService(name, env);

        if (result.ok || (!enable && isMissingComposeService(result.output))) {
          applied[name] = enable;
          continue;
        }
        const detail = result.timedOut
          ? `abandoned after ${this.config.serviceTimeoutSeconds}s`
          : tail(result.output, 4);
        failures.push(`${name}: ${detail}`);
      }

      this.store.setAppliedManagedServices(applied, managedServicesEnvFingerprint(request.env));

      if (failures.length > 0) {
        const detail = failures.join("; ");
        this.store.setManagedServicesStatus({
          state: "failed",
          ...said("servicesPartial", `Could not apply every optional service: ${detail}`, {
            detail,
          }),
          triggeredAt,
          error: detail,
        });
        return;
      }

      const running = MANAGED_SERVICES.filter((name) => applied[name]);
      this.store.setManagedServicesStatus({
        state: "applied",
        ...(running.length > 0
          ? said("servicesRunning", `Running: ${running.join(", ")}.`, {
              services: running.join(", "),
            })
          : said("servicesOff", "The optional services are off.")),
        triggeredAt,
        appliedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setManagedServicesStatus({
        state: "failed",
        ...said("servicesFailed", `Applying the optional services failed: ${message}`, {
          detail: message,
        }),
        triggeredAt,
        error: message,
      });
    }
  }
}
