/**
 * Unpairing on the controller must send the agent idle without a restart, whichever call notices
 * first: the stream the controller closes, its refused reconnect, or a signed status or result
 * answered 401 while the old stream still reads nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CONTROLLER_AGENT_ROUTES } from "@cpm/shared";
import { loadConfig } from "../../src/config";
import { AgentStore } from "../../src/db";
import type { DockerHost } from "../../src/docker";
import { AgentLifecycle } from "../../src/lifecycle";
import type { Operations } from "../../src/operations";

const ORIGINAL_FETCH = globalThis.fetch;
const CONTROLLER_URL = "http://controller:3000";
const SECRET = "c".repeat(64);
const UNAUTHORIZED = {
  errors: [
    {
      message: "The request is not signed by a paired agent.",
      extensions: { code: "AGENT_UNAUTHORIZED" },
    },
  ],
};

let dir: string;
let store: AgentStore;
let lifecycle: AgentLifecycle | null;
/** "stream" or "status" per signed request, in order. */
let requests: string[];
/** Each stream's abort signal, to prove the agent hung up the one it held. */
let streams: AbortSignal[];

type Controller = {
  /** One per stream request: the frames it sends, then whether it stays open. */
  stream: (attempt: number) => { frames: unknown[]; open: boolean };
  status: () => unknown;
};

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function stubController(controller: Controller) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path !== CONTROLLER_AGENT_ROUTES.graphql) return new Response("", { status: 404 });
    const headers = new Headers(init?.headers);
    if (headers.get("accept") === "text/event-stream") {
      const attempt = requests.filter((r) => r === "stream").length;
      requests.push("stream");
      if (init?.signal) streams.push(init.signal);
      const { frames, open } = controller.stream(attempt);
      const body = new ReadableStream<Uint8Array>({
        start(sink) {
          for (const payload of frames) sink.enqueue(new TextEncoder().encode(frame(payload)));
          if (!open) sink.close();
          init?.signal?.addEventListener("abort", () => {
            try {
              sink.error(new DOMException("aborted", "AbortError"));
            } catch {
              // Already closed.
            }
          });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    requests.push("status");
    return new Response(JSON.stringify(controller.status()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const hello = {
  data: { agentEvents: { type: "hello", controllerId: "ctl", controllerName: "Ctl" } },
};

function stubDocker(): DockerHost {
  return {
    caddyRunning: async () => false,
    startCaddy: async () => ({ ok: true, output: "" }),
    stopCaddy: async () => ({ ok: true, output: "" }),
    composeProject: async () => "cpm",
  } as unknown as DockerHost;
}

function startLifecycle(streamSilenceMs?: number): AgentLifecycle {
  store.upsertController({ controllerId: "ctl", controllerName: "Ctl", secret: SECRET });
  store.setPairedControllerUrl(CONTROLLER_URL);
  lifecycle = new AgentLifecycle({
    config: loadConfig(),
    store,
    docker: stubDocker(),
    operations: {} as Operations,
    streamSilenceMs,
  });
  return lifecycle;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const idle = async () => (await lifecycle!.localState()).lifecycle === "idle";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-unpaired-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  // A code by hand, so going idle does not start watching for a bootstrap token.
  process.env.CONTROLLER_URL = CONTROLLER_URL;
  process.env.PAIRING_CODE = "ABCDEF";
  delete process.env.CONTROLLER_DATA_DIR;
  store = new AgentStore(join(dir, "agent.db"));
  lifecycle = null;
  requests = [];
  streams = [];
});

afterEach(() => {
  lifecycle?.stop();
  globalThis.fetch = ORIGINAL_FETCH;
  store.close();
  Bun.gc(true);
  delete process.env.CONTROLLER_URL;
  delete process.env.PAIRING_CODE;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

describe("an agent the controller unpaired", () => {
  it("goes idle on a 401 status while its old stream stays open", async () => {
    stubController({
      stream: () => ({ frames: [hello], open: true }),
      status: () => UNAUTHORIZED,
    });
    await startLifecycle().start();

    await waitFor(idle);

    const state = await lifecycle!.localState();
    expect(state.message).toMatch(/no longer recognises this agent/i);
    expect(state.controllerUrl).toBeNull();
    expect(store.listControllers()).toEqual([]);
    // The stream it was blocked on is hung up, and nothing reconnects or posts again.
    expect(streams[0]?.aborted).toBe(true);
    const settled = requests.length;
    await Bun.sleep(1_500);
    expect(requests).toHaveLength(settled);
  });

  it("goes idle when the closed stream's reconnect is refused", async () => {
    stubController({
      stream: (attempt) =>
        attempt === 0 ? { frames: [hello], open: false } : { frames: [UNAUTHORIZED], open: false },
      status: () => ({ data: { agentStatus: true } }),
    });
    await startLifecycle().start();

    await waitFor(idle);

    expect(requests.filter((r) => r === "stream")).toHaveLength(2);
    expect(store.pairedControllerUrl()).toBeNull();
  });

  it("reconnects a stream that has gone silent, and is refused there", async () => {
    stubController({
      // No hello: nothing posts a status, so only the silence can end the first stream.
      stream: (attempt) =>
        attempt === 0 ? { frames: [], open: true } : { frames: [UNAUTHORIZED], open: false },
      status: () => ({ data: { agentStatus: true } }),
    });
    await startLifecycle(200).start();

    await waitFor(idle);

    expect(streams[0]?.aborted).toBe(true);
    expect(requests).toEqual(["stream", "stream"]);
  });

  it("keeps a pairing that replaced the one a late 401 was signed with", async () => {
    stubController({
      stream: () => ({ frames: [], open: true }),
      status: () => ({ data: { agentStatus: true } }),
    });
    await startLifecycle().start();

    const inner = lifecycle as unknown as { forget(secret: string): Promise<void> };
    await inner.forget("d".repeat(64));

    expect((await lifecycle!.localState()).lifecycle).toBe("paired");
    expect(store.pairedControllerUrl()).toBe(CONTROLLER_URL);
  });
});
