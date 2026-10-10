/**
 * A command runs beside the event stream, not on it: a validate or a log read that takes seconds
 * must not hold up the desired-state frame behind it, and shutdown waits for what is in flight.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentDesiredState } from "@cpm/shared";
import { loadConfig } from "../../src/config";
import { AgentStore } from "../../src/db";
import type { DockerHost } from "../../src/docker";
import { AgentLifecycle } from "../../src/lifecycle";
import type { Operations } from "../../src/operations";

let dir: string;
let store: AgentStore;
let lifecycle: AgentLifecycle;

type Inner = {
  handle(event: unknown): Promise<void>;
  execute(command: unknown): Promise<void>;
};

function desired(offline: boolean): AgentDesiredState {
  return {
    l4Ports: [],
    caddyModules: [],
    services: { services: { clickhouse: false }, env: {} },
    fleetConfig: { offline } as AgentDesiredState["fleetConfig"],
    caddyEnabled: false,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-commands-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  store = new AgentStore(join(dir, "agent.db"));
  lifecycle = new AgentLifecycle({
    config: loadConfig(),
    store,
    docker: { caddyRunning: async () => false } as unknown as DockerHost,
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
  store.close();
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

describe("commands on the event stream", () => {
  it("lets the next frame through while a command is still running, and drains on stop", async () => {
    const inner = lifecycle as unknown as Inner;
    let finish: (() => void) | undefined;
    const started: unknown[] = [];
    inner.execute = (command: unknown) => {
      started.push(command);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };

    await inner.handle({ type: "command", command: { id: "c1", kind: "log-read" } });
    expect(started).toHaveLength(1);
    // The frame after it is applied at once, with the command still open.
    await inner.handle({ type: "desired-state", state: desired(true) });
    expect(store.controllerOffline()).toBe(true);

    let drained = false;
    const draining = lifecycle.drainCommands().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish?.();
    await draining;
    expect(drained).toBe(true);
  });
});
