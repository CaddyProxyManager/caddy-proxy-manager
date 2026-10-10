/**
 * Talks to the agent already running on this host, or becomes it. The only listener is a local
 * socket: the agent dials its controller, so a host behind NAT needs no inbound port.
 */

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AGENT_LOCAL_ROUTES,
  type AgentLocalPairPreviewResponse,
  type AgentLocalPairResponse,
  type AgentLocalState,
} from "@cpm/shared";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { stop as stopAnalytics } from "./analytics/runner";
import { effectiveBuildMode, loadConfig } from "./config";
import { AgentStore } from "./db";
import { DockerHost } from "./docker";
import { AgentLifecycle } from "./lifecycle";
import { createLocalHandler } from "./local-server";
import { adoptLegacyState } from "./migrate";
import { Operations } from "./operations";
import { AGENT_VERSION } from "./status";

/**
 * Before any env is read, so `--help` works unconfigured. `hideBin` suits the compiled binary
 * too: `bun build --compile` keeps argv's two-element prefix.
 */
const argv = yargs(hideBin(process.argv))
  .scriptName("cpm-agent")
  .usage(
    "$0 [options]\n\nManages this host's Caddy container on behalf of a Caddy Proxy Manager " +
      "controller.\n\nStarted with no controller, the agent idles and leaves Caddy stopped. Pair " +
      "it from the host with:\n  cpm-agent --pair --host 10.0.0.5 --code ABCDEF",
  )
  .option("pair", {
    type: "boolean",
    default: false,
    describe: "Hand --host/--port/--code to the agent already running on this host, then exit",
  })
  .option("host", {
    type: "string",
    describe:
      "Controller address. A bare host means https://, except loopback and single-label names",
    defaultDescription: "$CONTROLLER_URL",
  })
  .option("port", {
    type: "number",
    describe: "Controller port, when the address does not carry one",
    defaultDescription: "3000",
  })
  .option("code", {
    type: "string",
    describe: "Six-letter pairing code, read off the controller's Settings page",
    defaultDescription: "$PAIRING_CODE",
  })
  .option("yes", {
    alias: "y",
    type: "boolean",
    default: false,
    describe: "With --pair: skip the confirmation, for a script with no terminal to answer it",
  })
  .option("healthcheck", {
    type: "boolean",
    default: false,
    describe: "Probe the running agent over its local socket, then exit 0 if it answered",
  })
  .version(AGENT_VERSION)
  // An ignored typo in the HEALTHCHECK would start a second agent and look healthy doing it.
  .strict()
  .help()
  .check((parsed) => {
    if (parsed.pair && !parsed.host) throw new Error("--pair needs --host.");
    if (parsed.pair && !parsed.code) throw new Error("--pair needs --code.");
    if (parsed.yes && !parsed.pair) throw new Error("--yes only applies to --pair.");
    if (parsed.pair && parsed.healthcheck)
      throw new Error("--pair and --healthcheck are separate.");
    return true;
  })
  .parseSync();

const config = loadConfig({
  // Under --pair these are the message to send, not this process's config to validate.
  controllerHost: argv.pair ? null : argv.host,
  controllerPort: argv.pair ? null : argv.port,
  pairingCode: argv.pair ? null : argv.code,
});

function localFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // outbound: agentSocket
  return fetch(`http://agent.local${path}`, {
    unix: config.socketPath,
    signal: AbortSignal.timeout(20_000),
    ...init,
  });
}

// ─── --healthcheck ───────────────────────────────────────────────────────────

/** The image has no curl; dialing the socket proves the agent answers, not just that it exists. */
if (argv.healthcheck) {
  try {
    const response = await localFetch(AGENT_LOCAL_ROUTES.health);
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

// ─── --pair ──────────────────────────────────────────────────────────────────

/** A message, not a mode: the running agent holds the database and the stream. */
if (argv.pair) {
  if (!existsSync(config.socketPath)) {
    console.error(
      `No agent is listening on ${config.socketPath}. Start the agent first - pairing is handed ` +
        `to the running process, not performed by this one.`,
    );
    process.exit(1);
  }

  const pairBody = JSON.stringify({ host: argv.host, port: argv.port, code: argv.code });

  // The preview names the controller without spending the code, catching a wrong address first.
  if (!argv.yes) {
    let preview: AgentLocalPairPreviewResponse;
    try {
      const response = await localFetch(AGENT_LOCAL_ROUTES.pairPreview, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pairBody,
      });
      if (response.status === 404) {
        // The binary was updated before the running agent restarted.
        preview = { ok: false, error: "The running agent is too old to confirm a pairing." };
      } else {
        preview = (await response.json()) as AgentLocalPairPreviewResponse;
      }
    } catch (error) {
      console.error(`Could not reach the agent on ${config.socketPath}: ${describeError(error)}`);
      process.exit(1);
    }
    if (!preview.ok) {
      console.error(preview.error);
      process.exit(1);
    }
    if (!(await confirmPairing(preview))) {
      console.log("Not paired. Nothing was changed, and the code is still valid.");
      process.exit(1);
    }
  }

  try {
    const response = await localFetch(AGENT_LOCAL_ROUTES.pair, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: pairBody,
    });
    const body = (await response.json()) as AgentLocalPairResponse;

    if (!body.ok) {
      console.error(body.error ?? "The agent refused the pairing.");
      process.exit(1);
    }
    console.log(`Paired with ${body.state.controllerUrl}.`);
    console.log(describeState(body.state));
    process.exit(0);
  } catch (error) {
    console.error(`Could not reach the agent on ${config.socketPath}: ${describeError(error)}`);
    process.exit(1);
  }
}

/**
 * Needs a terminal: without `-it` there is no stdin, and reading that as "no" would look like a
 * pairing failing for no reason, so that case is told how to proceed.
 */
async function confirmPairing(
  preview: Extract<AgentLocalPairPreviewResponse, { ok: true }>,
): Promise<boolean> {
  const who = preview.controllerName
    ? `"${preview.controllerName}"${preview.controllerId ? ` (controller ${preview.controllerId.slice(0, 8)})` : ""}`
    : "a controller that does not report its name";
  console.log(`This agent is about to pair with ${who}`);
  console.log(`  at ${preview.controllerUrl}`);
  if (preview.repair) {
    console.log("  replacing this agent's existing pairing with that controller.");
  }

  if (!process.stdin.isTTY) {
    console.error(
      "Confirming needs a terminal. Run this with `docker exec -it`, or add --yes if you have " +
        "already checked the controller above.",
    );
    return false;
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Confirm pairing? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function describeState(state: AgentLocalState): string {
  if (state.caddy.running) return "Caddy is running.";
  if (state.caddy.allowed) return "Caddy is starting.";
  return "Caddy is stopped; the controller has not enabled it yet.";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Running the agent ───────────────────────────────────────────────────────

// Before the store opens, which would create the empty database that makes this skip.
try {
  if (adoptLegacyState(config.dataDir, config.controllerDataDir)) {
    console.log(`[agent] copied this agent's state from ${config.controllerDataDir}`);
  }
} catch (error) {
  console.warn(
    `[agent] could not copy this agent's state from ${config.controllerDataDir}; starting with a ` +
      "fresh database, which the controller will see as a new agent:",
    error,
  );
}

const store = new AgentStore(join(config.dataDir, "agent.db"));
const docker = new DockerHost(config);
docker.setBuildModeSource(() => effectiveBuildMode(config, store));
const operations = new Operations(config, store, docker);

operations.clearStaleStatuses();

const lifecycle = new AgentLifecycle({
  config,
  store,
  docker,
  operations,
  // Releases socket and store before `unless-stopped` restarts us; Caddy was just restarted.
  exit: (reason) => shutdown(`restart (${reason})`, { stopCaddy: false }),
});

// A killed process's leftover socket file makes bind fail with EADDRINUSE.
if (existsSync(config.socketPath)) unlinkSync(config.socketPath);

const server = Bun.serve({ unix: config.socketPath, fetch: createLocalHandler(lifecycle) });

// `--pair` and the healthcheck `docker exec` as the socket's own user; nobody else needs it.
chmodSync(config.socketPath, 0o660);
console.log(`[agent] ${AGENT_VERSION} listening on ${config.socketPath}`);

await lifecycle.start();

const state = await lifecycle.localState();
if (state.lifecycle === "idle") {
  console.log(`[agent] idle: ${state.message}`);
}

// The base compose files carry no L4 port override, so this keeps L4 alive across a reboot.
// After the listener, so a slow `docker inspect` cannot delay readiness.
void operations.restorePublishedPorts().catch((error: unknown) => {
  console.warn("[agent] could not restore the Caddy container's published ports:", error);
});

/** Inside the compose `stop_grace_period`, leaving room to release the socket and store. */
const CADDY_SHUTDOWN_TIMEOUT_SECONDS = 40;

let shuttingDown = false;

function shutdown(signal: string, options: { stopCaddy: boolean } = { stopCaddy: true }): void {
  // A second Ctrl+C must not start a second shutdown.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent] ${signal} received, shutting down`);
  lifecycle.stop();
  // Caddy goes down with its agent rather than serving a config nothing here can change, and the
  // managed services with it, in parallel to fit the grace period.
  void Promise.all([
    options.stopCaddy
      ? Promise.all([
          lifecycle.stopCaddyForShutdown(CADDY_SHUTDOWN_TIMEOUT_SECONDS),
          lifecycle.stopServicesForShutdown(CADDY_SHUTDOWN_TIMEOUT_SECONDS),
        ])
      : Promise.resolve(),
    // A command caught mid-flight still answers; the controller would otherwise wait it out.
    lifecycle.drainCommands(),
  ])
    .then(() => stopAnalytics())
    .catch(() => {
      // Regardless: a stuck parser must not keep the socket from being released.
    })
    .then(() => server.stop(true))
    .then(() => {
      store.close();
      if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
      process.exit(0);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
