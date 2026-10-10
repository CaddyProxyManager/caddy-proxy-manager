/**
 * The agent's lifecycle, and the only thing that starts Caddy (compose keeps it behind a profile).
 * An unpaired agent stays `idle` with Caddy stopped, so "paired" and "serving traffic" are one
 * state and a half-installed host never answers on 80 and 443.
 */

import {
  AGENT_BOOTSTRAP_FILE,
  AGENT_BOOTSTRAP_TOKEN_PATTERN,
  AGENT_RECONNECT_MAX_MS,
  AGENT_RECONNECT_MIN_MS,
  AGENT_STATUS_HEARTBEAT_MS,
  AGENT_STREAM_KEEPALIVE_MS,
  type AgentCommand,
  type AgentCommandResult,
  type AgentDesiredState,
  type AgentLifecycle as Lifecycle,
  type AgentLocalState,
  type AgentServerEvent,
  CADDY_VALIDATE_REFUSED_STATUS,
  type CaddyValidateRequest,
  type CertificateFileRequest,
  type LogReadRequest,
  type LogReadResponse,
  MANAGED_SERVICES,
  type ManagedServiceName,
  type ManagedServicesRequest,
  MAX_CADDY_CONFIG_BYTES,
  SHIPPED_CADDY_MODULES,
  sameL4PortSet,
  type AgentLocalPairPreviewResponse,
  AgentDecodeError,
  type CertificateFilesReadRequest,
  decodeCertificateFileSources,
} from "@cpm/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFleetConfig } from "./analytics/runner";
import {
  CaddyAdminUnreachable,
  digestResponse,
  forwardToCaddy,
  isAllowedAdminPath,
  loadsConfig,
  pinAdminListen,
} from "./caddy-admin";
import { type AgentConfig, effectiveBuildMode } from "./config";
import { ControllerClient, ControllerRejected } from "./controller-client";
import {
  ControllerAddressError,
  checkControllerTransport,
  normalizeControllerUrl,
  normalizePairingCode,
} from "./controller-url";
import type { AgentStore } from "./db";
import { composeEnv, type DockerHost, managedServicesEnvFingerprint, tail } from "./docker";
import { listCaddyCertificates, readCaddyCertificate } from "./certificates";
import {
  CertificateFilePoller,
  listCertificateFiles,
  readCertificateFiles,
} from "./certificate-files";
import {
  CONTAINER_LOG_CURSOR,
  MAX_LOG_LINES,
  logFileFor,
  parseContainerLogs,
  readLogFile,
} from "./logs";
import { OperationBusyError, type Operations } from "./operations";
import { AGENT_VERSION, buildStatus } from "./status";

export type LifecycleDeps = {
  config: AgentConfig;
  store: AgentStore;
  docker: DockerHost;
  operations: Operations;
  /** For a controller-requested restart; the entrypoint releases socket and store first. */
  exit?: (reason: string) => void;
  /** Tests only: a minute of silence is too long to wait for. */
  streamSilenceMs?: number;
};

/** Pairs a co-starting stack in seconds; cheap for remote agents that never get a token. */
const BOOTSTRAP_POLL_MS = 3_000;
/** How long an image load waits for the controller's narrowed config before recreating anyway. */
const NARROWED_CONFIG_TIMEOUT_MS = 60_000;
/** Three missed pings: a stream the controller closed can stay open under us, reading nothing. */
const STREAM_SILENCE_MS = 3 * AGENT_STREAM_KEEPALIVE_MS;
const FORGOTTEN_MESSAGE =
  "The controller no longer recognises this agent. Pair it again with a fresh code.";

export type PairOutcome = { ok: true } | { ok: false; error: string };

export class AgentLifecycle {
  private lifecycle: Lifecycle = "idle";
  private message: string | null = null;
  private client: ControllerClient | null = null;
  private secret: string | null = null;
  private controllerId: string | null = null;
  private connection: AbortController | null = null;
  private stopped = false;
  private desired: AgentDesiredState | null = null;
  /** Frames and deferred retries apply one at a time, each against the newest desired state. */
  private reconciling: Promise<void> = Promise.resolve();
  private retryQueued = false;
  /** What each operation was last started with, so a deferred retry never repeats a failure. */
  private attempted: { l4Ports?: string[]; modules?: string[]; services?: string } = {};
  /** Caddy being started again after the agent's own shutdown stopped it; see `start`. */
  private caddyRestore: Promise<void> | null = null;
  /** The same for the managed services; awaited before a frame may stop them. */
  private servicesRestore: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Resolved by the next config load forwarded to Caddy; see `nextConfigLoad`. */
  private configLoadWaiters: (() => void)[] = [];
  private bootstrapWatch: ReturnType<typeof setInterval> | null = null;
  private readonly certificateFiles: CertificateFilePoller;

  /** CADDY_BUILD_TIMEOUT as the agent started: what a controller that sends no timeout gets. */
  private readonly envBuildTimeoutSeconds: number;

  constructor(private readonly deps: LifecycleDeps) {
    this.envBuildTimeoutSeconds = deps.config.buildTimeoutSeconds;
    this.certificateFiles = new CertificateFilePoller(deps.config, deps.docker, (results) => {
      const client = this.client;
      const secret = this.secret;
      if (!client || !secret) return Promise.reject(new Error("Not paired."));
      return client.postCertificateFiles(secret, results).catch((error: unknown) => {
        if (isUnpaired(error)) void this.forget(secret);
        throw error;
      });
    });
  }

  // ─── Entry points ──────────────────────────────────────────────────────────

  /**
   * Resume a stored pairing, else pair from config, else idle. Stored wins: a leftover `--code`
   * would otherwise re-pair on every restart with a spent code and land back in idle.
   */
  async start(): Promise<void> {
    const storedUrl = this.deps.store.pairedControllerUrl();
    const [storedController] = this.deps.store.listControllers();
    // Cleared at once: it describes the last shutdown, and only this start acts on it.
    const restoreCaddy = this.deps.store.caddyStoppedForShutdown();
    this.deps.store.setCaddyStoppedForShutdown(false);
    const restoreServices = this.deps.store.servicesStoppedForShutdown();
    this.deps.store.setServicesStoppedForShutdown([]);
    this.servicesRestore = (
      restoreServices.length > 0 ? this.restoreServices(restoreServices) : Promise.resolve()
    ).then(() => this.forgetMissingServices());

    if (storedUrl && storedController) {
      // Also on resume, so a pairing stored before public plain http was refused stops using it.
      // The pairing is kept: opting in and restarting resumes it.
      try {
        const warning = checkControllerTransport(storedUrl, this.deps.config.allowInsecureHttp);
        if (warning) console.warn(`[agent] ${warning}`);
      } catch (error) {
        if (!(error instanceof ControllerAddressError)) throw error;
        await this.goIdle(error.message);
        return;
      }
      this.adopt(storedUrl, storedController.controllerId, storedController.secret);
      console.log(`[agent] resuming pairing with ${storedUrl}`);
      // Before the controller answers, so a reboot with the controller down still serves; the
      // first reconcile stops it again if the controller has Caddy off.
      if (restoreCaddy) this.caddyRestore = this.startCaddy().catch(() => {});
      void this.run();
      return;
    }

    const { controllerUrl, pairingCode } = this.deps.config;
    const code = pairingCode ?? this.readBootstrapToken();
    if (controllerUrl && code) {
      const outcome = await this.pairWith(controllerUrl, code);
      if (!outcome.ok) {
        console.warn(`[agent] ${outcome.error}`);
        // A token found at boot can fail to redeem because the controller is still starting.
        this.rearmBootstrapWatch();
      }
      return;
    }

    await this.goIdle(
      controllerUrl
        ? "No pairing code. Run `cpm-agent --pair --host <controller> --code <code>`."
        : "No controller configured. Run `cpm-agent --pair --host <controller> --code <code>`.",
    );
    this.rearmBootstrapWatch();
  }

  /**
   * Watch for a bootstrap token whenever idle: the controller writes it as it boots (or after a
   * rebuild), and a single read that lost that race left the agent idle forever. An explicit
   * `--code` opts out.
   */
  private rearmBootstrapWatch(): void {
    const { controllerUrl, pairingCode } = this.deps.config;
    if (controllerUrl && !pairingCode) this.watchForBootstrapToken(controllerUrl);
  }

  /** Failures are left to the next tick unlogged: usually the controller is just not up yet. */
  private watchForBootstrapToken(controllerUrl: string): void {
    if (this.bootstrapWatch) return;
    this.bootstrapWatch = setInterval(() => {
      if (this.stopped || this.lifecycle !== "idle") {
        this.clearBootstrapWatch();
        return;
      }
      const token = this.readBootstrapToken();
      if (!token) return;
      this.clearBootstrapWatch();
      void this.pairWith(controllerUrl, token).then((outcome) => {
        if (outcome.ok) return;
        // A retry can fix it (controller still starting), so keep watching.
        console.warn(`[agent] ${outcome.error}`);
        if (!this.stopped && this.lifecycle === "idle") this.watchForBootstrapToken(controllerUrl);
      });
    }, BOOTSTRAP_POLL_MS);
  }

  private clearBootstrapWatch(): void {
    if (this.bootstrapWatch) clearInterval(this.bootstrapWatch);
    this.bootstrapWatch = null;
  }

  /**
   * The controller's bootstrap token from its data volume. Mounting that volume means the same
   * host and trust boundary; absent is normal for every remote agent.
   */
  private readBootstrapToken(): string | null {
    const { controllerDataDir, dataDir } = this.deps.config;
    const path = join(controllerDataDir ?? dataDir, AGENT_BOOTSTRAP_FILE);
    try {
      if (!existsSync(path)) return null;
      const token = readFileSync(path, "utf-8").trim();
      return AGENT_BOOTSTRAP_TOKEN_PATTERN.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  /** Validated here, not in the CLI, so flag, env and local route refuse a bad address alike. */
  async pair(host: string, port: number | null, code: string): Promise<PairOutcome> {
    let url: string;
    let normalizedCode: string;
    try {
      url = normalizeControllerUrl(host, port);
      normalizedCode = normalizePairingCode(code);
      const warning = checkControllerTransport(url, this.deps.config.allowInsecureHttp);
      if (warning) console.warn(`[agent] ${warning}`);
    } catch (error) {
      if (error instanceof ControllerAddressError) return { ok: false, error: error.message };
      throw error;
    }
    return this.pairWith(url, normalizedCode);
  }

  /** Who `pair` would pair with, so the CLI can confirm by name. Touches no state. */
  async previewPair(
    host: string,
    port: number | null,
    code: string,
  ): Promise<AgentLocalPairPreviewResponse> {
    let url: string;
    let normalizedCode: string;
    try {
      url = normalizeControllerUrl(host, port);
      normalizedCode = normalizePairingCode(code);
      checkControllerTransport(url, this.deps.config.allowInsecureHttp);
    } catch (error) {
      if (error instanceof ControllerAddressError) return { ok: false, error: error.message };
      throw error;
    }

    const agentId = this.deps.store.agentId();
    try {
      const preview = await new ControllerClient(url, agentId).previewPair({
        code: normalizedCode,
        agentId,
      });
      return {
        ok: true,
        controllerUrl: url,
        controllerName: preview?.controllerName ?? null,
        controllerId: preview?.controllerId ?? null,
        repair: preview?.repair ?? false,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async localState(): Promise<AgentLocalState> {
    return {
      lifecycle: this.lifecycle,
      agentId: this.deps.store.agentId(),
      version: AGENT_VERSION,
      controllerUrl: this.client?.controllerUrl ?? this.deps.store.pairedControllerUrl(),
      caddy: {
        running: await this.deps.docker.caddyRunning().catch(() => false),
        allowed: this.caddyAllowed(),
      },
      message: this.message,
    };
  }

  /**
   * Stop Caddy with the agent that owns it, and remember that it did. Bounded: the container's
   * grace period is short and a shutting-down daemon may never answer. Never throws.
   */
  async stopCaddyForShutdown(timeoutSeconds: number): Promise<void> {
    try {
      if (!(await this.deps.docker.caddyRunning())) return;
      console.log("[agent] stopping Caddy before shutting down");
      const result = await this.deps.docker.stopCaddy(timeoutSeconds);
      if (result.ok) {
        this.deps.store.setCaddyStoppedForShutdown(true);
      } else {
        console.error(
          result.timedOut
            ? `[agent] Caddy did not stop within ${timeoutSeconds}s; shutting down anyway`
            : `[agent] could not stop Caddy: ${result.output}`,
        );
      }
    } catch (error) {
      console.error("[agent] could not stop Caddy:", error);
    }
  }

  /**
   * The managed services too: `docker compose down` skips them behind their profiles, so stopping
   * them here is what takes them down with the stack. Only those this agent started, which only
   * the controller's own agent does. Bounded and never throws, as above.
   */
  async stopServicesForShutdown(timeoutSeconds: number): Promise<void> {
    try {
      const applied = this.deps.store.appliedManagedServices();
      if (!applied || !MANAGED_SERVICES.some((name) => applied[name])) return;
      const running = (await this.deps.docker.runningServices()).filter((name) => applied[name]);
      if (running.length === 0) return;
      console.log(`[agent] stopping ${running.join(" and ")} before shutting down`);
      let env: Record<string, string> = {};
      try {
        env = composeEnv(this.desired?.services.env);
      } catch {
        // A value compose cannot take only matters to `up`; `stop` still works without it.
      }
      const stopped: ManagedServiceName[] = [];
      await Promise.all(
        running.map(async (name) => {
          const result = await this.deps.docker.stopService(name, env, timeoutSeconds);
          if (result.ok) stopped.push(name);
          else console.error(`[agent] could not stop ${name}: ${tail(result.output, 3)}`);
        }),
      );
      this.deps.store.setServicesStoppedForShutdown(stopped);
    } catch (error) {
      console.error("[agent] could not stop the managed services:", error);
    }
  }

  /**
   * Whatever is unpaired: these were running before the shutdown and nothing else will start them.
   * A failed start is marked unapplied, so the controller's next frame recreates it with its env.
   */
  private async restoreServices(services: ManagedServiceName[]): Promise<void> {
    // Only names this agent manages, read back from its own store; in parallel, since the first
    // desired state waits on this.
    const known = services.filter((name) => MANAGED_SERVICES.includes(name));
    const failed = await Promise.all(
      known.map(async (name) => {
        console.log(`[agent] starting ${name} again`);
        const result = await this.deps.docker.resumeService(name).catch((error: unknown) => ({
          ok: false,
          output: String(error),
        }));
        if (result.ok) return null;
        console.error(`[agent] could not start ${name}: ${tail(result.output, 3)}`);
        return name;
      }),
    );
    const applied = this.deps.store.appliedManagedServices();
    const marked = failed.filter((name): name is ManagedServiceName => name !== null);
    if (applied && marked.length > 0) {
      this.deps.store.setAppliedManagedServices({
        ...applied,
        ...Object.fromEntries(marked.map((name) => [name, false])),
      });
    }
  }

  /**
   * A container removed by hand stays "applied", and `compose start` of nothing succeeds, so it
   * was never recreated. Marked unapplied, the first frame's `up` recreates it with its env.
   */
  private async forgetMissingServices(): Promise<void> {
    try {
      const applied = this.deps.store.appliedManagedServices();
      if (!applied || !MANAGED_SERVICES.some((name) => applied[name])) return;
      const running = await this.deps.docker.runningServices();
      const missing = MANAGED_SERVICES.filter((name) => applied[name] && !running.includes(name));
      if (missing.length === 0) return;
      console.log(`[agent] ${missing.join(" and ")} not running; starting on the next frame`);
      this.deps.store.setAppliedManagedServices({
        ...applied,
        ...Object.fromEntries(missing.map((name) => [name, false])),
      });
    } catch (error) {
      console.warn("[agent] could not compare the managed services with Docker:", error);
    }
  }

  /** Tear the stream down and stop reconnecting. Leaves Caddy exactly as it is. */
  stop(): void {
    this.stopped = true;
    this.connection?.abort();
    this.connection = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.certificateFiles.stop();
    // An armed interval keeps the process alive after SIGTERM until the kill.
    this.clearBootstrapWatch();
  }

  // ─── Pairing ───────────────────────────────────────────────────────────────

  private async pairWith(url: string, code: string): Promise<PairOutcome> {
    // Otherwise two controllers' desired state would race over one Caddy.
    this.connection?.abort();
    this.connection = null;
    this.lifecycle = "pairing";
    this.message = `Pairing with ${url}…`;

    const store = this.deps.store;
    const client = new ControllerClient(url, store.agentId());

    try {
      const response = await client.pair({
        code,
        agentId: store.agentId(),
        agentName: this.deps.config.caddyContainerName,
        agentVersion: AGENT_VERSION,
      });

      store.upsertController({
        controllerId: response.controllerId,
        controllerName: response.controllerName,
        secret: response.secret,
      });
      store.setPairedControllerUrl(url);
      this.adopt(url, response.controllerId, response.secret);
      console.log(`[agent] paired with ${response.controllerName} at ${url}`);
      void this.run();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.goIdle(message);
      return { ok: false, error: message };
    }
  }

  private adopt(url: string, controllerId: string, secret: string): void {
    this.client = new ControllerClient(url, this.deps.store.agentId());
    this.controllerId = controllerId;
    this.secret = secret;
    this.lifecycle = "paired";
    this.message = null;
  }

  /**
   * Any signed call answered 401 means the controller dropped this agent, not only the stream:
   * without this, a stream that never noticed the unpair kept an agent posting into 401s.
   */
  private async forget(secret: string): Promise<void> {
    // A call signed before a re-pair must not discard the pairing that replaced it.
    if (this.stopped || this.secret !== secret) return;
    this.deps.store.clearPairing();
    await this.goIdle(FORGOTTEN_MESSAGE);
    this.rearmBootstrapWatch();
  }

  /** Stops Caddy too: a revoked agent must not serve a config nobody can change any more. */
  private async goIdle(message: string): Promise<void> {
    this.lifecycle = "idle";
    this.message = message;
    this.client = null;
    this.secret = null;
    this.controllerId = null;
    this.desired = null;
    this.connection?.abort();
    this.connection = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.certificateFiles.stop();
    await this.stopCaddy("no controller is configured");
  }

  // ─── The stream ────────────────────────────────────────────────────────────

  /**
   * Only a 401 breaks the loop: the controller forgot this agent, so the secret is dead. Anything
   * else reconnects with backoff while Caddy keeps serving what it has.
   */
  private async run(): Promise<void> {
    let backoff = AGENT_RECONNECT_MIN_MS;
    this.startHeartbeat();

    while (!this.stopped && this.lifecycle === "paired") {
      const client = this.client;
      const secret = this.secret;
      if (!client || !secret) return;

      const connection = new AbortController();
      this.connection = connection;
      // Paused while an event is handled, so a slow reconcile is not mistaken for silence.
      let silent = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const watch = () => {
        watchdog = setTimeout(() => {
          silent = true;
          connection.abort();
        }, this.deps.streamSilenceMs ?? STREAM_SILENCE_MS);
      };

      try {
        watch();
        for await (const event of client.events(secret, connection.signal)) {
          clearTimeout(watchdog);
          backoff = AGENT_RECONNECT_MIN_MS;
          await this.handle(event);
          watch();
        }
      } catch (error) {
        if (connection.signal.aborted && !silent) return;
        if (isUnpaired(error)) {
          await this.forget(secret);
          return;
        }
        console.warn(`[agent] stream lost, retrying in ${Math.round(backoff / 1000)}s:`, error);
      } finally {
        clearTimeout(watchdog);
      }

      if (this.stopped || (connection.signal.aborted && !silent)) return;
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, AGENT_RECONNECT_MAX_MS);
    }
  }

  private async handle(event: AgentServerEvent): Promise<void> {
    switch (event.type) {
      case "hello":
        console.log(`[agent] attached to ${event.controllerName}`);
        void this.reportStatus();
        return;
      case "desired-state":
        await this.queueReconcile(() => event.state);
        return;
      case "command":
        await this.execute(event.command);
        return;
      case "restart":
        await this.restart(event.reason);
        return;
    }
  }

  /**
   * Restart Caddy (only if running, so setup never opens 80/443 early), then exit. Not `compose
   * restart agent`: stopping this container kills that command, and `unless-stopped` does not undo
   * an explicit stop - it does undo an exit.
   */
  private async restart(reason: string): Promise<void> {
    console.log(`[agent] restart requested: ${reason}`);
    if (await this.deps.docker.caddyRunning().catch(() => false)) {
      console.log("[agent] restarting Caddy");
      const result = await this.deps.docker.restartCaddy();
      if (!result.ok) console.error("[agent] could not restart Caddy:", result.output);
    }
    (this.deps.exit ?? (() => process.exit(0)))(reason);
  }

  // ─── Reconciliation ────────────────────────────────────────────────────────

  private queueReconcile(state: () => AgentDesiredState | null, retry = false): Promise<void> {
    const next = this.reconciling.then(() => {
      const latest = state();
      return latest ? this.reconcile(latest, retry) : undefined;
    });
    this.reconciling = next.catch(() => {});
    return next;
  }

  /**
   * When the recreate ends, not at the next heartbeat: the controller reloads the new Caddy on
   * hearing of it, since a config sent while the old one was stopping never reached it.
   */
  private reportWhenRecreated(): void {
    this.deps.operations.whenIdle(() => void this.reportStatus());
  }

  /** Once per busy spell, and against whatever frame is newest by then. */
  private retryWhenIdle(): void {
    if (this.retryQueued) return;
    this.retryQueued = true;
    this.deps.operations.whenIdle(() => {
      this.retryQueued = false;
      // Unpairing clears `desired`, so an agent gone idle meanwhile applies nothing.
      if (this.stopped) return;
      this.queueReconcile(() => this.desired, true).catch((error: unknown) => {
        console.warn("[agent] could not apply a deferred desired state:", error);
      });
    });
  }

  /** Diffs only: each reconnect resends full state, and a blind apply rebuilds Caddy's image. */
  private async reconcile(state: AgentDesiredState, retry = false): Promise<void> {
    // Else a "Caddy off" finds nothing running yet and the restore brings it up anyway.
    if (this.caddyRestore) {
      await this.caddyRestore;
      this.caddyRestore = null;
    }
    if (this.servicesRestore) {
      await this.servicesRestore;
      this.servicesRestore = null;
    }
    this.desired = state;
    const { store, operations } = this.deps;
    // Before the build decision below, which reads it.
    store.setControllerOffline(state.fleetConfig.offline === true);
    // Settings -> Caddy build, on the controller; the docker and operations objects share this
    // config, so a build started after this frame waits as the admin set.
    const pushedTimeout = state.fleetConfig.caddyBuildTimeoutSeconds;
    this.deps.config.buildTimeoutSeconds =
      typeof pushedTimeout === "number" && Number.isInteger(pushedTimeout) && pushedTimeout > 0
        ? pushedTimeout
        : this.envBuildTimeoutSeconds;

    if (!state.caddyEnabled) {
      await this.stopCaddy("the controller has it switched off");
    } else {
      await this.startCaddy();
    }

    // A retry skips what already ran with this input: a build failing in under a second otherwise
    // restarted forever, starving the services queued behind it. A controller frame still retries.
    const tried = this.attempted;
    const services = servicesKey(state.services);
    try {
      // As port sets: the same ports come as ranges or one by one, as the controller knew this agent.
      if (
        !sameL4PortSet(state.l4Ports, store.appliedL4Ports()) &&
        !(retry && tried.l4Ports && sameL4PortSet(state.l4Ports, tried.l4Ports))
      ) {
        operations.applyL4Ports(state.l4Ports);
        tried.l4Ports = state.l4Ports;
        this.reportWhenRecreated();
      }

      // Null means never rebuilt (the shipped image), not "skip", or no first rebuild ever runs.
      // External mode never builds: the operator does, and loads the result on request.
      const appliedModules = store.appliedCaddyModules() ?? [...SHIPPED_CADDY_MODULES];
      if (
        effectiveBuildMode(this.deps.config, store) === "agent" &&
        !sameList(state.caddyModules, appliedModules) &&
        !(retry && tried.modules && sameList(state.caddyModules, tried.modules))
      ) {
        operations.applyCaddyBuild(state.caddyModules);
        tried.modules = state.caddyModules;
        this.reportWhenRecreated();
      }

      const appliedServices = store.appliedManagedServices();
      if (
        (!sameServices(state.services.services, appliedServices) ||
          managedServicesEnvFingerprint(state.services.env) !==
            store.appliedManagedServicesEnv()) &&
        !(retry && tried.services === services)
      ) {
        operations.applyManagedServices(state.services);
        tried.services = services;
      }
    } catch (busy) {
      if (busy instanceof OperationBusyError) {
        // Retried when it ends: the controller sends no further frame until something changes.
        console.log(`[agent] deferring: ${busy.running} is already running`);
        this.retryWhenIdle();
      } else {
        throw busy;
      }
    }

    // Absent from a controller that predates the field, or when this agent has no directory.
    try {
      this.certificateFiles.update(
        state.certificateFiles === undefined
          ? []
          : decodeCertificateFileSources(state.certificateFiles),
      );
    } catch (error) {
      if (!(error instanceof AgentDecodeError)) throw error;
      console.warn(`[agent] ignoring the certificate files the controller sent: ${error.message}`);
    }

    if (this.controllerId) {
      await applyFleetConfig(store, state.fleetConfig, this.controllerId).catch(
        (error: unknown) => {
          console.warn("[agent] could not apply the pushed fleet configuration:", error);
        },
      );
    }

    void this.reportStatus();
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  private async execute(command: AgentCommand): Promise<void> {
    const result = await this.runCommand(command);
    const client = this.client;
    const secret = this.secret;
    if (!client || !secret) return;
    await client.postResults(secret, [result]).catch((error: unknown) => {
      if (isUnpaired(error)) return this.forget(secret);
      // No retry: the controller times the command out, and a late result finds no waiter.
      console.warn(`[agent] could not return the result of command ${command.id}:`, error);
    });
  }

  private async runCommand(command: AgentCommand): Promise<AgentCommandResult> {
    if (command.kind === "caddy-validate") return this.runValidate(command.id, command.request);
    if (command.kind === "log-read") return this.runLogRead(command.id, command.request);
    if (command.kind === "certificate-list") return this.runCertificateList(command.id);
    if (command.kind === "caddy-image-load") return this.runCaddyImageLoad(command.id);
    if (command.kind === "certificate-read") {
      return this.runCertificateRead(command.id, command.request);
    }
    if (command.kind === "certificate-files-list") return this.runCertificateFilesList(command.id);
    if (command.kind === "certificate-files-read") {
      return this.runCertificateFilesRead(command.id, command.request);
    }
    if (!isAllowedAdminPath(command.request.path)) {
      return {
        id: command.id,
        ok: false,
        code: "BAD_REQUEST",
        error: `"${command.request.path}" is not a Caddy admin path this agent will forward.`,
      };
    }
    if ((command.request.body?.length ?? 0) > MAX_CADDY_CONFIG_BYTES) {
      return { id: command.id, ok: false, code: "BAD_REQUEST", error: "The config is too large." };
    }

    let request = command.request;
    const listen = this.deps.config.caddyAdminListen;
    if (listen && request.body && loadsConfig(request)) {
      const body = pinAdminListen(request.body, listen);
      if (body === null) {
        return {
          id: command.id,
          ok: false,
          code: "BAD_REQUEST",
          error: "A config for Caddy must be a JSON object.",
        };
      }
      request = { ...request, body };
    }

    try {
      const response = await forwardToCaddy(this.deps.config.caddyApiUrl, request);
      if (loadsConfig(request) && response.status < 300) {
        for (const resolve of this.configLoadWaiters.splice(0)) resolve();
      }
      return {
        id: command.id,
        ok: true,
        response: request.digest ? digestResponse(response) : response,
      };
    } catch (error) {
      const code = error instanceof CaddyAdminUnreachable ? "BUSY" : "INTERNAL";
      return {
        id: command.id,
        ok: false,
        code,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** True once the controller loads a config through here, false after `timeoutMs`. */
  private nextConfigLoad(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.configLoadWaiters = this.configLoadWaiters.filter((waiter) => waiter !== done);
        resolve(false);
      }, timeoutMs);
      this.configLoadWaiters.push(done);
    });
  }

  private runCaddyImageLoad(id: string): AgentCommandResult {
    if (effectiveBuildMode(this.deps.config, this.deps.store) !== "external") {
      return {
        id,
        ok: false,
        code: "BAD_REQUEST",
        error: "This agent builds Caddy's image itself; set CADDY_BUILD_MODE=external to load one.",
      };
    }
    let loading: Promise<void>;
    try {
      loading = this.deps.operations.loadCaddyImage(async () => {
        const loaded = this.nextConfigLoad(NARROWED_CONFIG_TIMEOUT_MS);
        await this.reportStatus();
        return loaded;
      });
    } catch (busy) {
      if (!(busy instanceof OperationBusyError)) throw busy;
      return { id, ok: false, code: "BUSY", error: `${busy.running} is already running.` };
    }
    // Both ends reported now, not on the next heartbeat: the panel is polling for them.
    void this.reportStatus();
    void loading.then(() => this.reportStatus());
    return { id, ok: true, response: { status: 200, text: "", headers: {} } };
  }

  private async runCertificateList(id: string): Promise<AgentCommandResult> {
    const certificates = await listCaddyCertificates(this.deps.docker);
    if (!certificates)
      return { id, ok: false, code: "BUSY", error: "Caddy's storage is unreadable." };
    return {
      id,
      ok: true,
      response: { status: 200, text: JSON.stringify(certificates), headers: {} },
    };
  }

  private async runCertificateRead(
    id: string,
    request: CertificateFileRequest,
  ): Promise<AgentCommandResult> {
    const files = await readCaddyCertificate(this.deps.docker, request);
    return files
      ? { id, ok: true, response: { status: 200, text: JSON.stringify(files), headers: {} } }
      : { id, ok: true, response: { status: 404, text: "", headers: {} } };
  }

  private async runCertificateFilesList(id: string): Promise<AgentCommandResult> {
    if (!this.deps.config.certFilesHostDir) {
      return { id, ok: false, code: "BAD_REQUEST", error: "CERT_FILES_HOST_DIR is not set." };
    }
    const entries = await listCertificateFiles(this.deps.config, this.deps.docker);
    if (!entries) {
      return { id, ok: false, code: "BUSY", error: "The certificate directory is unreadable." };
    }
    return { id, ok: true, response: { status: 200, text: JSON.stringify(entries), headers: {} } };
  }

  /** Every PEM, for a new certificate or "Re-read now"; the poller keeps sending on its own. */
  private async runCertificateFilesRead(
    id: string,
    request: CertificateFilesReadRequest,
  ): Promise<AgentCommandResult> {
    let files: ReturnType<typeof decodeCertificateFileSources>;
    try {
      files = decodeCertificateFileSources(request?.files);
    } catch (error) {
      if (!(error instanceof AgentDecodeError)) throw error;
      return { id, ok: false, code: "BAD_REQUEST", error: error.message };
    }
    const results = await readCertificateFiles(this.deps.config, this.deps.docker, files);
    return { id, ok: true, response: { status: 200, text: JSON.stringify(results), headers: {} } };
  }

  /** The answer is JSON in a 200's text. */
  private async runLogRead(id: string, request: LogReadRequest): Promise<AgentCommandResult> {
    const answer = (page: LogReadResponse): AgentCommandResult => ({
      id,
      ok: true,
      response: { status: 200, text: JSON.stringify(page), headers: {} },
    });
    const file = logFileFor(request?.source);
    if (file) {
      try {
        return answer(await readLogFile(file, request));
      } catch (error) {
        return { id, ok: false, code: "INTERNAL", error: String(error) };
      }
    }
    if (request?.source !== "caddy") {
      return { id, ok: false, code: "BAD_REQUEST", error: "Unknown log source." };
    }
    // Only a timestamp: it becomes a docker CLI argument, and anything else could read as a flag.
    const cursor =
      typeof request.cursor === "string" && CONTAINER_LOG_CURSOR.test(request.cursor)
        ? request.cursor
        : null;
    const limit = Math.min(Math.max(Number(request.limit) || 200, 1), MAX_LOG_LINES);
    const logs = await this.deps.docker.caddyLogs({ since: cursor, tail: limit });
    if (!logs.ok) return { id, ok: false, code: "BUSY", error: tail(logs.output, 3) };
    return answer(parseContainerLogs(logs.output, cursor, limit));
  }

  /** Not pinned like a load: nothing binds, and the container has no network anyway. */
  private async runValidate(
    id: string,
    request: CaddyValidateRequest,
  ): Promise<AgentCommandResult> {
    if (typeof request?.config !== "string" || request.config.length > MAX_CADDY_CONFIG_BYTES) {
      return { id, ok: false, code: "BAD_REQUEST", error: "The config is missing or too large." };
    }
    const validation = await this.deps.docker.validateCaddyConfig(request.config);
    if (validation.state === "unavailable") {
      return { id, ok: false, code: "BUSY", error: validation.reason };
    }
    const status = validation.state === "accepted" ? 200 : CADDY_VALIDATE_REFUSED_STATUS;
    return { id, ok: true, response: { status, text: validation.output, headers: {} } };
  }

  // ─── Caddy ─────────────────────────────────────────────────────────────────

  private caddyAllowed(): boolean {
    return this.lifecycle === "paired" && this.desired?.caddyEnabled === true;
  }

  private async startCaddy(): Promise<void> {
    if (!(await this.deps.docker.caddyRunning())) {
      console.log("[agent] starting Caddy");
      const result = await this.deps.docker.startCaddy();
      if (!result.ok) console.error("[agent] could not start Caddy:", result.output);
    }
    // Also when already running: the operator may have swapped the image while the agent was down.
    if (effectiveBuildMode(this.deps.config, this.deps.store) === "external") {
      const list = await this.deps.operations.syncModulesFromImage();
      if (list.state === "unreadable") {
        console.warn(`[agent] could not read Caddy's module list: ${list.reason}`);
      }
    } else {
      await this.adoptImageModules();
    }
  }

  /**
   * A release bump pulls the stock image under the tag a rebuild had replaced, dropping its
   * modules while the store still lists them; nothing rebuilt, and Caddy's autosave then failed to
   * load. Recording what the image carries makes the next diff rebuild.
   */
  private async adoptImageModules(): Promise<void> {
    if (this.deps.operations.isRunning("caddy-build")) return;
    const list = await this.deps.docker.readCaddyModuleList().catch(() => null);
    if (list?.state !== "found") return;
    const store = this.deps.store;
    if (sameList(list.modules, store.appliedCaddyModules() ?? [...SHIPPED_CADDY_MODULES])) return;
    console.log("[agent] Caddy's image carries other modules than were built; rebuilding");
    store.setAppliedCaddyModules(list.modules);
  }

  private async stopCaddy(reason: string): Promise<void> {
    if (!(await this.deps.docker.caddyRunning().catch(() => false))) return;
    console.log(`[agent] stopping Caddy: ${reason}`);
    const result = await this.deps.docker.stopCaddy();
    if (!result.ok) console.error("[agent] could not stop Caddy:", result.output);
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  /** On a timer as well as on change: "last seen" must tell a quiet agent from a dead one. */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => void this.reportStatus(), AGENT_STATUS_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private async reportStatus(): Promise<void> {
    const client = this.client;
    const secret = this.secret;
    if (!client || !secret) return;
    try {
      const status = await buildStatus(this.deps);
      await client.postStatus(secret, status);
    } catch (error) {
      if (isUnpaired(error)) return this.forget(secret);
      // Status is advisory; the stream is what proves the agent is alive.
      console.warn("[agent] could not report status:", error);
    }
  }
}

function isUnpaired(error: unknown): boolean {
  return error instanceof ControllerRejected && error.status === 401;
}

/** Order-insensitive comparison: the controller sorts, but a stored list may predate that. */
function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function servicesKey(request: ManagedServicesRequest): string {
  const wanted = MANAGED_SERVICES.map((name) => request.services[name] ?? false);
  return `${wanted.join()}|${managedServicesEnvFingerprint(request.env)}`;
}

function sameServices(
  wanted: Partial<Record<string, boolean>>,
  applied: Record<string, boolean> | null,
): boolean {
  if (applied === null) return false;
  // Only services this agent manages, or one it lacks would re-apply on every frame.
  return MANAGED_SERVICES.every((name) => (wanted[name] ?? false) === (applied[name] ?? false));
}
