/**
 * A desired-state frame that finds another operation running must still be applied once it ends:
 * the controller sends no further frame until something changes, so dropping it left a managed
 * CrowdSec unstarted behind an L4 port change (docker-tests/suite/agent-tests/85-crowdsec-managed).
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
import { loadConfig } from "../src/config";
import { AgentStore } from "../src/db";
import type { DockerHost } from "../src/docker";
import { AgentLifecycle } from "../src/lifecycle";
import { OperationBusyError, Operations } from "../src/operations";

let dir: string;
let store: AgentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-deferred-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  store = new AgentStore(join(dir, "agent.db"));
});

afterEach(() => {
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
const SHARING: ManagedServicesRequest = {
  ...ON,
  env: { ...ON.env, CROWDSEC_DISABLE_ONLINE_API: "false" },
};

function desired(services: ManagedServicesRequest): AgentDesiredState {
  return {
    l4Ports: [],
    caddyModules: [...SHIPPED_CADDY_MODULES],
    services,
    fleetConfig: {} as AgentDesiredState["fleetConfig"],
    caddyEnabled: false,
  };
}

const ok = { ok: true, exitCode: 0, output: "", timedOut: false };

describe("Operations.whenIdle", () => {
  it("calls back at once when nothing runs", () => {
    const operations = new Operations(loadConfig(), store, {} as DockerHost);
    let called = 0;
    operations.whenIdle(() => called++);
    expect(called).toBe(1);
  });

  it("waits for the running operation to end", async () => {
    let finish: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const docker = {
      startService: async () => {
        await started;
        return ok;
      },
      stopService: async () => ok,
    } as unknown as DockerHost;
    const operations = new Operations(loadConfig(), store, docker);

    operations.applyManagedServices(ON);
    let called = 0;
    operations.whenIdle(() => called++);
    expect(() => operations.applyManagedServices(ON)).toThrow(OperationBusyError);
    expect(called).toBe(0);

    finish();
    for (let i = 0; i < 20 && called === 0; i++) await Bun.sleep(1);
    expect(called).toBe(1);
    // A later operation starts cleanly, so the running flag was released first.
    expect(() => operations.applyManagedServices(ON)).not.toThrow();
  });
});

describe("a frame deferred by a running operation", () => {
  it("is applied once the operation ends, as the newest frame", async () => {
    let busy = true;
    let idle: (() => void) | null = null;
    let registrations = 0;
    const applies: ManagedServicesRequest[] = [];
    const lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: { caddyRunning: async () => false } as unknown as DockerHost,
      operations: {
        applyL4Ports: () => {},
        applyCaddyBuild: () => {},
        applyManagedServices: (request: ManagedServicesRequest) => {
          if (busy) throw new OperationBusyError("l4-ports");
          applies.push(request);
        },
        whenIdle: (listener: () => void) => {
          registrations++;
          idle = listener;
        },
      } as unknown as Operations,
    });
    const inner = lifecycle as unknown as {
      handle(event: unknown): Promise<void>;
      reconciling: Promise<void>;
    };

    await inner.handle({ type: "desired-state", state: desired(ON) });
    await inner.handle({ type: "desired-state", state: desired(SHARING) });
    expect(applies).toEqual([]);
    expect(registrations).toBe(1);

    busy = false;
    (idle as (() => void) | null)?.();
    await inner.reconciling;
    expect(applies).toEqual([SHARING]);
    lifecycle.stop();
  });

  it("is dropped when the agent stopped meanwhile", async () => {
    let idle: (() => void) | null = null;
    const applies: ManagedServicesRequest[] = [];
    let busy = true;
    const lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: { caddyRunning: async () => false } as unknown as DockerHost,
      operations: {
        applyL4Ports: () => {},
        applyCaddyBuild: () => {},
        applyManagedServices: (request: ManagedServicesRequest) => {
          if (busy) throw new OperationBusyError("services");
          applies.push(request);
        },
        whenIdle: (listener: () => void) => {
          idle = listener;
        },
      } as unknown as Operations,
    });
    const inner = lifecycle as unknown as {
      handle(event: unknown): Promise<void>;
      reconciling: Promise<void>;
    };

    await inner.handle({ type: "desired-state", state: desired(ON) });
    lifecycle.stop();
    busy = false;
    (idle as (() => void) | null)?.();
    await inner.reconciling;
    expect(applies).toEqual([]);
  });
});

// The controller reloads a recreated Caddy on hearing the port change finished; at the heartbeat,
// an L4 host saved during the recreate stayed unserved for up to a minute.
describe("a port change", () => {
  it("reports status again the moment it ends", async () => {
    let ended: (() => void) | null = null;
    const ports: string[][] = [];
    const lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: { caddyRunning: async () => false } as unknown as DockerHost,
      operations: {
        applyL4Ports: (next: string[]) => ports.push(next),
        applyCaddyBuild: () => {},
        applyManagedServices: () => {},
        whenIdle: (listener: () => void) => {
          ended = listener;
        },
      } as unknown as Operations,
    });
    const inner = lifecycle as unknown as {
      handle(event: unknown): Promise<void>;
      reportStatus(): Promise<void>;
    };
    let reports = 0;
    inner.reportStatus = async () => {
      reports++;
    };

    await inner.handle({
      type: "desired-state",
      state: { ...desired(ON), l4Ports: ["9000:9000"] },
    });
    expect(ports).toEqual([["9000:9000"]]);
    const before = reports;
    expect(ended).not.toBeNull();
    (ended as (() => void) | null)?.();
    expect(reports).toBe(before + 1);
    lifecycle.stop();
  });
});
