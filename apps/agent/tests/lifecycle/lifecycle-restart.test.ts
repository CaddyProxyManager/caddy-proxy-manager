/**
 * Sent as the controller restarts after migrating its database. Caddy is restarted only when
 * running: before setup it is not, and starting it would answer 80 and 443 too early.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config";
import { AgentStore } from "../../src/db";
import type { DockerHost } from "../../src/docker";
import { AgentLifecycle } from "../../src/lifecycle";
import type { Operations } from "../../src/operations";

const ORIGINAL_FETCH = globalThis.fetch;
const CONTROLLER_URL = "http://controller:3000";

let dir: string;
let store: AgentStore;
let lifecycle: AgentLifecycle | null;

/** A controller whose stream delivers one restart frame and then stays open. */
function stubController(reason: string) {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("accept") === "text/event-stream") {
      const frame = JSON.stringify({ data: { agentEvents: { type: "restart", reason } } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
          },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function stubDocker(running: boolean, log: string[]): DockerHost {
  return {
    caddyRunning: async () => running,
    restartCaddy: async () => {
      log.push("restartCaddy");
      return { ok: true, output: "" };
    },
    startCaddy: async () => ({ ok: true, output: "" }),
    stopCaddy: async () => ({ ok: true, output: "" }),
  } as unknown as DockerHost;
}

function seedPairing() {
  store.upsertController({ controllerId: "ctl", controllerName: "Ctl", secret: "c".repeat(64) });
  store.setPairedControllerUrl(CONTROLLER_URL);
}

async function untilExit(exits: string[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (exits.length === 0 && Date.now() < deadline) await Bun.sleep(10);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-restart-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  process.env.CONTROLLER_URL = CONTROLLER_URL;
  delete process.env.PAIRING_CODE;
  delete process.env.CONTROLLER_DATA_DIR;
  store = new AgentStore(join(dir, "agent.db"));
  lifecycle = null;
});

afterEach(() => {
  lifecycle?.stop();
  globalThis.fetch = ORIGINAL_FETCH;
  store.close();
  delete process.env.CONTROLLER_URL;
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

describe("a restart asked for by the controller", () => {
  it("restarts Caddy when it is running, then exits with the reason", async () => {
    stubController("migration");
    seedPairing();
    const docker: string[] = [];
    const exits: string[] = [];
    lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: stubDocker(true, docker),
      operations: {} as Operations,
      exit: (reason) => exits.push(reason),
    });

    await lifecycle.start();
    await untilExit(exits);

    expect(docker).toEqual(["restartCaddy"]);
    expect(exits).toEqual(["migration"]);
  });

  it("leaves a stopped Caddy stopped and still exits", async () => {
    stubController("migration");
    seedPairing();
    const docker: string[] = [];
    const exits: string[] = [];
    lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: stubDocker(false, docker),
      operations: {} as Operations,
      exit: (reason) => exits.push(reason),
    });

    await lifecycle.start();
    await untilExit(exits);

    expect(docker).toEqual([]);
    expect(exits).toEqual(["migration"]);
  });
});
