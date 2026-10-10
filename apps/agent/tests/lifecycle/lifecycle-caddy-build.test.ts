/**
 * Whether a desired-state frame starts a Caddy rebuild - the only trigger one has. With no applied
 * modules recorded the baseline is the shipped image, or a fresh install's first rebuild is lost
 * and an unchanged selection recompiles Caddy on every reconnect.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type AgentDesiredState, SHIPPED_CADDY_MODULES } from "@cpm/shared";
import { loadConfig } from "../../src/config";
import { AgentStore } from "../../src/db";
import type { DockerHost } from "../../src/docker";
import { AgentLifecycle } from "../../src/lifecycle";
import type { Operations } from "../../src/operations";

const TAILSCALE = "github.com/tailscale/caddy-tailscale";

let dir: string;
let store: AgentStore;
/** The module list of every rebuild the lifecycle started, in order. */
let builds: string[][];
let lifecycle: AgentLifecycle;

function desired(caddyModules: string[]): AgentDesiredState {
  return {
    l4Ports: [],
    caddyModules,
    services: { services: { clickhouse: false }, env: {} },
    fleetConfig: {} as AgentDesiredState["fleetConfig"],
    caddyEnabled: false,
  };
}

/** Feed one frame through the same handler the stream uses. */
async function push(state: AgentDesiredState): Promise<void> {
  const inner = lifecycle as unknown as { handle(event: unknown): Promise<void> };
  await inner.handle({ type: "desired-state", state });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-caddy-build-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  store = new AgentStore(join(dir, "agent.db"));
  builds = [];
  lifecycle = new AgentLifecycle({
    config: loadConfig(),
    store,
    docker: { caddyRunning: async () => false } as unknown as DockerHost,
    operations: {
      applyL4Ports: () => {},
      whenIdle: (listener: () => void) => listener(),
      applyManagedServices: () => {},
      applyCaddyBuild: (modules: string[]) => builds.push(modules),
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

describe("an agent that has never rebuilt Caddy", () => {
  it("rebuilds when the selection drops a module the shipped image carries", async () => {
    const withoutTailscale = SHIPPED_CADDY_MODULES.filter((m) => m !== TAILSCALE).sort();

    await push(desired(withoutTailscale));

    expect(builds).toEqual([withoutTailscale]);
  });

  it("rebuilds when the selection adds a custom module", async () => {
    const withCustom = [...SHIPPED_CADDY_MODULES, "github.com/greenpau/caddy-security"].sort();

    await push(desired(withCustom));

    expect(builds).toEqual([withCustom]);
  });

  it("does not rebuild when the selection is the shipped set, in any order", async () => {
    // The controller sorts; the Dockerfile's list is not. Every reconnect repeats this frame.
    await push(desired([...SHIPPED_CADDY_MODULES].sort()));
    await push(desired([...SHIPPED_CADDY_MODULES].reverse()));

    expect(builds).toEqual([]);
  });
});

describe("an agent that has rebuilt Caddy", () => {
  it("does not rebuild for the set it last built", async () => {
    store.setAppliedCaddyModules([TAILSCALE]);

    await push(desired([TAILSCALE]));

    expect(builds).toEqual([]);
  });

  it("diffs against what it built, not the shipped image", async () => {
    store.setAppliedCaddyModules([TAILSCALE]);

    await push(desired([...SHIPPED_CADDY_MODULES]));

    expect(builds).toEqual([[...SHIPPED_CADDY_MODULES]]);
  });
});

describe("the Caddy build timeout the controller pushes", () => {
  it("follows the setting while a frame carries it, and the agent's own otherwise", async () => {
    const config = loadConfig();
    const fromEnv = config.buildTimeoutSeconds;
    lifecycle.stop();
    lifecycle = new AgentLifecycle({
      config,
      store,
      docker: { caddyRunning: async () => false } as unknown as DockerHost,
      operations: {
        applyL4Ports: () => {},
        whenIdle: (listener: () => void) => listener(),
        applyManagedServices: () => {},
        applyCaddyBuild: (modules: string[]) => builds.push(modules),
      } as unknown as Operations,
    });
    const shipped = [...SHIPPED_CADDY_MODULES];

    const pushed = desired(shipped);
    pushed.fleetConfig = { caddyBuildTimeoutSeconds: 42 } as AgentDesiredState["fleetConfig"];
    await push(pushed);
    expect(config.buildTimeoutSeconds).toBe(42);

    // An older controller sends none, and a bad value is no setting at all.
    const bad = desired(shipped);
    bad.fleetConfig = { caddyBuildTimeoutSeconds: -5 } as AgentDesiredState["fleetConfig"];
    await push(bad);
    expect(config.buildTimeoutSeconds).toBe(fromEnv);
    await push(desired(shipped));
    expect(config.buildTimeoutSeconds).toBe(fromEnv);
  });
});
