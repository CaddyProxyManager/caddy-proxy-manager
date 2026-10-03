/**
 * Stopping the agent stops Caddy explicitly, which `restart: unless-stopped` does not undo, so the
 * agent records it and restarts Caddy on its next paired start, before the controller answers. If
 * the controller has turned Caddy off, the first desired state stops it again without racing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type AgentDesiredState, SHIPPED_CADDY_MODULES } from "@cpm/shared";
import { loadConfig } from "../src/config";
import { AgentStore } from "../src/db";
import type { CommandResult, DockerHost } from "../src/docker";
import { AgentLifecycle } from "../src/lifecycle";
import type { Operations } from "../src/operations";

const ORIGINAL_FETCH = globalThis.fetch;
const ok: CommandResult = { ok: true, exitCode: 0, output: "", timedOut: false };

let dir: string;
let store: AgentStore;
let lifecycle: AgentLifecycle;
/** Docker calls in order, e.g. "stop:40", "start". */
let calls: string[];
let running: boolean;
/** What the next stopCaddy answers. */
let stopResult: CommandResult;
/** Resolves a start that the test holds open, to put a desired state in the middle of it. */
let releaseStart: (() => void) | null;

function stubDocker(): DockerHost {
  return {
    caddyRunning: async () => running,
    stopCaddy: async (timeoutSeconds?: number) => {
      calls.push(`stop:${timeoutSeconds ?? "default"}`);
      if (stopResult.ok) running = false;
      return stopResult;
    },
    startCaddy: async () => {
      calls.push("start");
      if (releaseStart) await new Promise<void>((resolve) => (releaseStart = resolve));
      running = true;
      calls.push("started");
      return ok;
    },
  } as unknown as DockerHost;
}

function seedPairing() {
  store.upsertController({ controllerId: "ctl", controllerName: "Ctl", secret: "c".repeat(64) });
  store.setPairedControllerUrl("http://controller:3000");
}

async function push(state: Partial<AgentDesiredState>): Promise<void> {
  const inner = lifecycle as unknown as { handle(event: unknown): Promise<void> };
  await inner.handle({
    type: "desired-state",
    state: {
      l4Ports: [],
      caddyModules: [...SHIPPED_CADDY_MODULES],
      services: { services: { clickhouse: false }, env: {} },
      fleetConfig: {},
      caddyEnabled: false,
      ...state,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-shutdown-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  delete process.env.CONTROLLER_URL;
  delete process.env.PAIRING_CODE;
  delete process.env.CONTROLLER_DATA_DIR;
  store = new AgentStore(join(dir, "agent.db"));
  calls = [];
  running = true;
  stopResult = ok;
  releaseStart = null;
  // The resumed stream never gets anywhere: these tests are about what happens around it.
  globalThis.fetch = (async () =>
    new Response(new ReadableStream(), { status: 200 })) as unknown as typeof fetch;
  lifecycle = new AgentLifecycle({
    config: loadConfig(),
    store,
    docker: stubDocker(),
    operations: {
      applyL4Ports: () => {},
      whenIdle: (listener: () => void) => listener(),
      applyManagedServices: () => {},
      applyCaddyBuild: () => {},
    } as unknown as Operations,
  });
});

afterEach(() => {
  lifecycle.stop();
  globalThis.fetch = ORIGINAL_FETCH;
  store.close();
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

describe("shutting the agent down", () => {
  it("stops a running Caddy within the time it is given, and remembers doing so", async () => {
    await lifecycle.stopCaddyForShutdown(40);

    expect(calls).toEqual(["stop:40"]);
    expect(store.caddyStoppedForShutdown()).toBe(true);
  });

  it("leaves a stopped Caddy alone and records nothing", async () => {
    running = false;

    await lifecycle.stopCaddyForShutdown(40);

    expect(calls).toEqual([]);
    expect(store.caddyStoppedForShutdown()).toBe(false);
  });

  it("shuts down anyway when Caddy will not stop, without claiming it did", async () => {
    stopResult = { ok: false, exitCode: 124, output: "", timedOut: true };

    await lifecycle.stopCaddyForShutdown(40);

    expect(store.caddyStoppedForShutdown()).toBe(false);
  });
});

describe("starting after a shutdown stopped Caddy", () => {
  it("starts Caddy straight away when it still has a pairing", async () => {
    seedPairing();
    store.setCaddyStoppedForShutdown(true);
    running = false;

    await lifecycle.start();
    await Bun.sleep(10);

    expect(calls).toEqual(["start", "started"]);
    // Acted on once: the next start is not a restore unless another shutdown says so.
    expect(store.caddyStoppedForShutdown()).toBe(false);
  });

  it("does not start Caddy for an agent that has no pairing any more", async () => {
    store.setCaddyStoppedForShutdown(true);
    running = false;

    await lifecycle.start();
    await Bun.sleep(10);

    expect(calls).not.toContain("start");
    expect(store.caddyStoppedForShutdown()).toBe(false);
  });

  it("does not start Caddy when the last shutdown did not stop it", async () => {
    seedPairing();
    running = false;

    await lifecycle.start();
    await Bun.sleep(10);

    expect(calls).toEqual([]);
  });

  it("lets the controller turn Caddy back off once the restore has finished", async () => {
    seedPairing();
    store.setCaddyStoppedForShutdown(true);
    running = false;
    releaseStart = () => {};

    await lifecycle.start();
    // The controller says "off" while the restore is still starting Caddy.
    const reconciled = push({ caddyEnabled: false });
    await Bun.sleep(10);
    expect(calls).toEqual(["start"]);

    releaseStart();
    await reconciled;

    expect(calls).toEqual(["start", "started", "stop:default"]);
    expect(running).toBe(false);
  });
});
