/**
 * CADDY_BUILD_MODE=external: the agent never builds Caddy's image, loads the one the operator built
 * on request, and takes the applied module set from that image rather than assuming the catalog.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentCommand, AgentDesiredState } from "@cpm/shared";
import { loadConfig } from "../src/config";
import { AgentStore } from "../src/db";
import { type CaddyModuleList, type DockerHost, parseCaddyModuleList } from "../src/docker";
import { AgentLifecycle } from "../src/lifecycle";
import { OperationBusyError, Operations } from "../src/operations";
import { buildStatus } from "../src/status";

const TAILSCALE = "github.com/tailscale/caddy-tailscale";
const L4 = "github.com/mholt/caddy-l4";

let dir: string;
let store: AgentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-external-image-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  process.env.CADDY_BUILD_MODE = "external";
  store = new AgentStore(join(dir, "agent.db"));
});

afterEach(() => {
  delete process.env.CADDY_BUILD_MODE;
  delete process.env.PUID;
  store.close();
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

type FakeDocker = {
  list: CaddyModuleList;
  image: string | null;
  load: { ok: boolean; output: string };
  health: string;
  calls: string[];
};

function fakeDocker(overrides: Partial<FakeDocker> = {}): FakeDocker & DockerHost {
  const fake: FakeDocker = {
    list: { state: "found", modules: [L4] },
    image: "registry.example/caddy:custom",
    load: { ok: true, output: "" },
    health: "healthy",
    calls: [],
    ...overrides,
  };
  return Object.assign(fake, {
    caddyRunning: async () => true,
    readCaddyModuleList: async () => {
      fake.calls.push("read");
      return fake.list;
    },
    caddyImageRef: async () => fake.image,
    loadCaddyImage: async () => {
      fake.calls.push("load");
      return { ...fake.load, exitCode: fake.load.ok ? 0 : 1, timedOut: false };
    },
    waitForCaddyHealth: async () => fake.health,
    stopCaddy: async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }),
    composeProject: async () => "caddy-proxy-manager",
  }) as unknown as FakeDocker & DockerHost;
}

describe("parseCaddyModuleList", () => {
  it("reads the whitespace-separated list the Dockerfile writes", () => {
    expect(parseCaddyModuleList(`${L4} ${TAILSCALE}\n`)).toEqual([L4, TAILSCALE]);
    expect(parseCaddyModuleList("")).toEqual([]);
  });

  it("refuses anything that is not a module spec", () => {
    expect(parseCaddyModuleList(`${L4} $(reboot)`)).toBeNull();
    expect(parseCaddyModuleList("x".repeat(300 * 1024))).toBeNull();
  });
});

describe("syncModulesFromImage", () => {
  it("records the image's own list as applied, and which image it came from", async () => {
    const docker = fakeDocker({ list: { state: "found", modules: [TAILSCALE] } });
    await new Operations(loadConfig(), store, docker).syncModulesFromImage();
    expect(store.appliedCaddyModules()).toEqual([TAILSCALE]);
    expect(store.caddyImage()).toBe("registry.example/caddy:custom");
  });

  it("counts an image without a list as no plugins, never as the shipped catalog", async () => {
    const docker = fakeDocker({ list: { state: "missing" } });
    await new Operations(loadConfig(), store, docker).syncModulesFromImage();
    expect(store.appliedCaddyModules()).toEqual([]);
  });

  it("leaves the record alone when the list cannot be read", async () => {
    store.setAppliedCaddyModules([L4]);
    const docker = fakeDocker({ list: { state: "unreadable", reason: "daemon down" } });
    await new Operations(loadConfig(), store, docker).syncModulesFromImage();
    expect(store.appliedCaddyModules()).toEqual([L4]);
  });
});

describe("loadCaddyImage", () => {
  it("loads, reads the list before the health wait, and reports applied", async () => {
    const docker = fakeDocker();
    await new Operations(loadConfig(), store, docker).loadCaddyImage();
    expect(docker.calls).toEqual(["load", "read"]);
    expect(store.appliedCaddyModules()).toEqual([L4]);
    expect(store.caddyBuildStatus().state).toBe("applied");
  });

  it("still records the new list when Caddy comes up unhealthy on it", async () => {
    const docker = fakeDocker({ health: "unhealthy" });
    await new Operations(loadConfig(), store, docker).loadCaddyImage();
    expect(store.appliedCaddyModules()).toEqual([L4]);
    expect(store.caddyBuildStatus().state).toBe("failed");
  });

  it("changes nothing when the load itself fails", async () => {
    store.setAppliedCaddyModules([TAILSCALE]);
    const docker = fakeDocker({ load: { ok: false, output: "No such image" } });
    await new Operations(loadConfig(), store, docker).loadCaddyImage();
    expect(docker.calls).toEqual(["load"]);
    expect(store.appliedCaddyModules()).toEqual([TAILSCALE]);
    expect(store.caddyBuildStatus()).toMatchObject({ state: "failed", error: "No such image" });
  });

  it("refuses to start while another operation runs", async () => {
    const operations = new Operations(loadConfig(), store, fakeDocker());
    const first = operations.loadCaddyImage();
    expect(() => operations.loadCaddyImage()).toThrow(OperationBusyError);
    await first;
  });
});

describe("the lifecycle", () => {
  function lifecycle(options: { builds: string[][]; loads: number[]; busy?: boolean }) {
    return new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: fakeDocker(),
      operations: {
        applyL4Ports: () => {},
        applyManagedServices: () => {},
        applyCaddyBuild: (modules: string[]) => options.builds.push(modules),
        loadCaddyImage: () => {
          if (options.busy) throw new OperationBusyError("caddy-build");
          options.loads.push(1);
          return Promise.resolve();
        },
        syncModulesFromImage: async () => ({ state: "found", modules: [L4] }),
      } as unknown as Operations,
    });
  }

  const command: AgentCommand = { id: "c1", kind: "caddy-image-load", request: {} };
  const run = (agent: AgentLifecycle) =>
    (agent as unknown as { runCommand(c: AgentCommand): Promise<unknown> }).runCommand(command);

  it("never starts a build for a changed selection", async () => {
    const builds: string[][] = [];
    const agent = lifecycle({ builds, loads: [] });
    const state: AgentDesiredState = {
      l4Ports: [],
      caddyModules: [TAILSCALE],
      services: { services: { clickhouse: false }, env: {} },
      fleetConfig: {} as AgentDesiredState["fleetConfig"],
      caddyEnabled: false,
    };
    await (agent as unknown as { handle(e: unknown): Promise<void> }).handle({
      type: "desired-state",
      state,
    });
    expect(builds).toEqual([]);
    agent.stop();
  });

  it("starts a load on request and answers before it finishes", async () => {
    const loads: number[] = [];
    const agent = lifecycle({ builds: [], loads });
    expect(await run(agent)).toMatchObject({ id: "c1", ok: true, response: { status: 200 } });
    expect(loads).toEqual([1]);
    agent.stop();
  });

  it("says busy rather than queueing behind another operation", async () => {
    const agent = lifecycle({ builds: [], loads: [], busy: true });
    expect(await run(agent)).toMatchObject({ ok: false, code: "BUSY" });
    agent.stop();
  });

  it("refuses a load when it builds images itself", async () => {
    process.env.CADDY_BUILD_MODE = "agent";
    const loads: number[] = [];
    const agent = lifecycle({ builds: [], loads });
    expect(await run(agent)).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(loads).toEqual([]);
    agent.stop();
  });
});

describe("status", () => {
  it("reports the image and ids an operator's build needs, and only in external mode", async () => {
    process.env.PUID = "1000";
    store.setCaddyImage("registry.example/caddy:custom");
    const status = await buildStatus({ config: loadConfig(), store, docker: fakeDocker() });
    expect(status.caddyBuild.external).toEqual({
      image: "registry.example/caddy:custom",
      puid: "1000",
      pgid: "",
    });
    expect(status.capabilities).toContain("caddy-image");

    process.env.CADDY_BUILD_MODE = "agent";
    const building = await buildStatus({ config: loadConfig(), store, docker: fakeDocker() });
    expect(building.caddyBuild.external).toBeUndefined();
  });

  it("drops an id that is not a number, rather than failing the controller's decoder", async () => {
    process.env.PUID = "1000; rm -rf /";
    const status = await buildStatus({ config: loadConfig(), store, docker: fakeDocker() });
    expect(status.caddyBuild.external?.puid).toBe("");
  });

  it("refuses an unknown build mode at startup", () => {
    process.env.CADDY_BUILD_MODE = "sometimes";
    expect(() => loadConfig()).toThrow(/CADDY_BUILD_MODE/);
  });
});
