/**
 * Whether a desired-state frame re-applies the optional services. Every reconnect repeats the
 * frame, so an unchanged one must not; a changed flag or credential must, even with the on/off set
 * unchanged, or CrowdSec's online API switch would never reach its container.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type AgentDesiredState,
  type ManagedServicesRequest,
  SHIPPED_CADDY_MODULES,
} from "@cpm/shared";
import { loadConfig } from "../../src/config";
import { AgentStore } from "../../src/db";
import { type DockerHost, managedServicesEnvFingerprint } from "../../src/docker";
import { AgentLifecycle } from "../../src/lifecycle";
import type { Operations } from "../../src/operations";

let dir: string;
let store: AgentStore;
let applies: ManagedServicesRequest[];
let lifecycle: AgentLifecycle;

function desired(services: ManagedServicesRequest): AgentDesiredState {
  return {
    l4Ports: [],
    caddyModules: [...SHIPPED_CADDY_MODULES],
    services,
    fleetConfig: {} as AgentDesiredState["fleetConfig"],
    caddyEnabled: false,
  };
}

async function push(state: AgentDesiredState): Promise<void> {
  const inner = lifecycle as unknown as { handle(event: unknown): Promise<void> };
  await inner.handle({ type: "desired-state", state });
}

/** What a successful apply of `request` leaves behind. */
function recordApplied(request: ManagedServicesRequest): void {
  store.setAppliedManagedServices(
    {
      clickhouse: request.services.clickhouse === true,
      crowdsec: request.services.crowdsec === true,
    },
    managedServicesEnvFingerprint(request.env),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-services-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  store = new AgentStore(join(dir, "agent.db"));
  applies = [];
  lifecycle = new AgentLifecycle({
    config: loadConfig(),
    store,
    docker: { caddyRunning: async () => false } as unknown as DockerHost,
    operations: {
      applyL4Ports: () => {},
      whenIdle: (listener: () => void) => listener(),
      applyCaddyBuild: () => {},
      applyManagedServices: (request: ManagedServicesRequest) => applies.push(request),
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

const ON: ManagedServicesRequest = {
  services: { clickhouse: false, crowdsec: true },
  env: { CROWDSEC_BOUNCER_KEY: "a".repeat(64), CROWDSEC_DISABLE_ONLINE_API: "true" },
};

describe("optional services on a desired-state frame", () => {
  it("does not re-apply the frame it last applied", async () => {
    recordApplied(ON);
    await push(desired(ON));
    expect(applies).toEqual([]);
  });

  it("re-applies when only a variable changed", async () => {
    recordApplied(ON);
    const sharing = { ...ON, env: { ...ON.env, CROWDSEC_DISABLE_ONLINE_API: "false" } };
    await push(desired(sharing));
    expect(applies).toEqual([sharing]);
  });

  it("re-applies once for a record from before the digest was kept", async () => {
    store.setAppliedManagedServices({ clickhouse: false, crowdsec: true });
    await push(desired(ON));
    expect(applies).toHaveLength(1);
  });

  it("reads a service missing from an older record as off", async () => {
    const off = { services: { clickhouse: true }, env: {} };
    store.setAppliedManagedServices(
      { clickhouse: true } as { clickhouse: boolean; crowdsec: boolean },
      managedServicesEnvFingerprint({}),
    );
    await push(desired(off));
    expect(applies).toEqual([]);
  });
});
