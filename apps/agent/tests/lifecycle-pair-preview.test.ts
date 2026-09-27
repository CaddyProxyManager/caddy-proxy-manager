/**
 * `--pair` previews the controller first: nothing stored, nothing dialled but the preview, the code
 * unspent - and a controller too old to answer must not block pairing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CONTROLLER_AGENT_ROUTES } from "@cpm/shared";
import { loadConfig } from "../src/config";
import { AgentStore } from "../src/db";
import type { DockerHost } from "../src/docker";
import { AgentLifecycle } from "../src/lifecycle";
import type { Operations } from "../src/operations";

const ORIGINAL_FETCH = globalThis.fetch;

let dir: string;
let store: AgentStore;
let lifecycle: AgentLifecycle;
let requests: { path: string; body: unknown }[];

/** Anything but the preview route answers 500. */
function stubController(respond: () => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === CONTROLLER_AGENT_ROUTES.pairPreview) return respond();
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-preview-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  delete process.env.CONTROLLER_URL;
  delete process.env.PAIRING_CODE;
  delete process.env.CONTROLLER_DATA_DIR;
  store = new AgentStore(join(dir, "agent.db"));
  requests = [];
  lifecycle = new AgentLifecycle({
    config: loadConfig(),
    store,
    docker: { caddyRunning: async () => false } as unknown as DockerHost,
    operations: {} as Operations,
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

describe("previewing a pairing", () => {
  it("names the controller and changes nothing", async () => {
    stubController(() =>
      json({ controllerId: "0123456789abcdef", controllerName: "Edge Controller", repair: false }),
    );

    const preview = await lifecycle.previewPair("controller", 3000, " abcdef ");

    expect(preview).toEqual({
      ok: true,
      controllerUrl: "http://controller:3000",
      controllerName: "Edge Controller",
      controllerId: "0123456789abcdef",
      repair: false,
    });
    // Only the preview was asked, with the code as pairing would send it.
    expect(requests.map((r) => r.path)).toEqual([CONTROLLER_AGENT_ROUTES.pairPreview]);
    expect(requests[0]?.body).toEqual({ code: "ABCDEF", agentId: store.agentId() });
    // Nothing stored, still idle: answering "no" leaves the agent as it was.
    expect(store.pairedControllerUrl()).toBeNull();
    expect(store.listControllers()).toEqual([]);
    expect((await lifecycle.localState()).lifecycle).toBe("idle");
  });

  it("still lets the operator decide when the controller predates previews", async () => {
    stubController(() => new Response("not found", { status: 404 }));

    const preview = await lifecycle.previewPair("controller", 3000, "ABCDEF");

    expect(preview).toEqual({
      ok: true,
      controllerUrl: "http://controller:3000",
      controllerName: null,
      controllerId: null,
      repair: false,
    });
  });

  it("passes on the controller's refusal of a wrong code", async () => {
    stubController(() => json({ error: "That pairing code is not valid." }, 401));

    const preview = await lifecycle.previewPair("controller", 3000, "ABCDEF");

    expect(preview).toEqual({ ok: false, error: "That pairing code is not valid." });
  });

  it("refuses an address pairing would refuse, without dialling anything", async () => {
    stubController(() => json({}));

    const preview = await lifecycle.previewPair("controller/path", null, "ABCDEF");

    expect(preview.ok).toBe(false);
    expect(requests).toEqual([]);
  });
});
