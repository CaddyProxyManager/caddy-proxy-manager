/**
 * A controller rebuilt with a fresh database 401s the resumed stream but writes a new bootstrap
 * token, so after dropping the dead secret the agent must go back to watching for one. An explicit
 * `--code` opts out: a spent hand-typed code must not be retried every few seconds.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AGENT_BOOTSTRAP_FILE, CONTROLLER_AGENT_ROUTES } from "@cpm/shared";
import { loadConfig } from "../../src/config";
import { AgentStore } from "../../src/db";
import type { DockerHost } from "../../src/docker";
import { AgentLifecycle } from "../../src/lifecycle";
import type { Operations } from "../../src/operations";

const ORIGINAL_FETCH = globalThis.fetch;
const CONTROLLER_URL = "http://controller:3000";
const TOKEN = "a".repeat(64);
/** One tick past the 3s bootstrap poll, so a watch that is armed has fired at least once. */
const PAST_ONE_POLL_MS = 4_500;

let dir: string;
let store: AgentStore;
let lifecycle: AgentLifecycle | null;
let requests: string[];

/** After pairing, the stream never closes: a closed one would send the agent into reconnects. */
function stubController() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === CONTROLLER_AGENT_ROUTES.pair) {
      return new Response(
        JSON.stringify({ secret: "b".repeat(64), controllerId: "ctl-new", controllerName: "New" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const headers = new Headers(init?.headers);
    if (headers.get("accept") === "text/event-stream") {
      const paired = requests.includes(CONTROLLER_AGENT_ROUTES.pair);
      if (!paired) return new Response("unauthenticated", { status: 401 });
      return new Response(new ReadableStream(), { status: 200 });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function stubDocker(): DockerHost {
  return {
    caddyRunning: async () => false,
    startCaddy: async () => ({ ok: true, output: "" }),
    stopCaddy: async () => ({ ok: true, output: "" }),
  } as unknown as DockerHost;
}

function seedStalePairing() {
  store.upsertController({
    controllerId: "ctl-old",
    controllerName: "Old",
    secret: "c".repeat(64),
  });
  store.setPairedControllerUrl(CONTROLLER_URL);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  process.env.CONTROLLER_URL = CONTROLLER_URL;
  delete process.env.PAIRING_CODE;
  delete process.env.CONTROLLER_DATA_DIR;
  store = new AgentStore(join(dir, "agent.db"));
  lifecycle = null;
  requests = [];
  stubController();
  writeFileSync(join(dir, AGENT_BOOTSTRAP_FILE), `${TOKEN}\n`);
});

afterEach(() => {
  lifecycle?.stop();
  globalThis.fetch = ORIGINAL_FETCH;
  store.close();
  delete process.env.CONTROLLER_URL;
  delete process.env.PAIRING_CODE;
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

describe("after the controller rejects a stored pairing", () => {
  it("pairs again with the bootstrap token the controller wrote", async () => {
    seedStalePairing();
    lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: stubDocker(),
      operations: {} as Operations,
    });

    await lifecycle.start();
    await Bun.sleep(PAST_ONE_POLL_MS);

    expect(requests).toContain(CONTROLLER_AGENT_ROUTES.pair);
    expect((await lifecycle.localState()).lifecycle).toBe("paired");
    expect(store.listControllers().map((c) => c.controllerId)).toEqual(["ctl-new"]);
    expect(store.pairedControllerUrl()).toBe(CONTROLLER_URL);
  });

  it("stays idle when the operator supplied a code by hand", async () => {
    process.env.PAIRING_CODE = "ABCDEF";
    seedStalePairing();
    lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: stubDocker(),
      operations: {} as Operations,
    });

    await lifecycle.start();
    await Bun.sleep(PAST_ONE_POLL_MS);

    expect(requests).not.toContain(CONTROLLER_AGENT_ROUTES.pair);
    expect((await lifecycle.localState()).lifecycle).toBe("idle");
    expect(store.listControllers()).toEqual([]);
  });
});
