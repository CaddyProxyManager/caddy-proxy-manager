/**
 * Pinned against the argv because each flag is a promise: no network, one capability, no attach
 * through the socket proxy, and the config copied in rather than mounted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type AgentCommand,
  type AgentCommandResult,
  CADDY_VALIDATE_REFUSED_STATUS,
} from "@cpm/shared";
import { loadConfig } from "../src/config";
import { AgentStore } from "../src/db";
import { type CaddyValidation, DockerHost } from "../src/docker";
import { AgentLifecycle } from "../src/lifecycle";
import type { Operations } from "../src/operations";

type Reply = { exitCode: number; stdout?: string };

let dir: string;
let spawned: string[][];
/** Answers by docker subcommand; anything unlisted succeeds with no output. */
let replies: Record<string, Reply>;
/** Read when `docker cp` is spawned. */
let copied: string | null;

const realSpawn = Bun.spawn;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-validate-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  spawned = [];
  copied = null;
  replies = { inspect: { exitCode: 0, stdout: "sha256:abc123\n" } };
  (Bun as { spawn: unknown }).spawn = ((argv: string[]) => {
    spawned.push(argv);
    if (argv[1] === "cp") copied = readFileSync(argv[2], "utf8");
    const reply = replies[argv[1]] ?? { exitCode: 0 };
    return {
      stdout: new Response(reply.stdout ?? "").body,
      stderr: new Response("").body,
      exited: Promise.resolve(reply.exitCode),
    };
  }) as unknown as typeof Bun.spawn;
});

afterEach(() => {
  (Bun as { spawn: unknown }).spawn = realSpawn;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

const subcommands = () => spawned.map((argv) => argv[1]);

describe("validateCaddyConfig", () => {
  it("creates, copies, starts, waits, reads and removes, in that order", async () => {
    replies.wait = { exitCode: 0, stdout: "0\n" };
    replies.logs = { exitCode: 0, stdout: '{"level":"info"}\nValid configuration\n' };
    const result = await new DockerHost(loadConfig()).validateCaddyConfig('{"apps":{}}');

    expect(result).toEqual({ state: "accepted", output: '{"level":"info"}\nValid configuration' });
    expect(subcommands()).toEqual(["inspect", "create", "cp", "start", "wait", "logs", "rm"]);
    expect(copied).toBe('{"apps":{}}');
  });

  it("runs Caddy's own image, isolated", async () => {
    replies.wait = { exitCode: 0, stdout: "0\n" };
    await new DockerHost(loadConfig()).validateCaddyConfig("{}");
    const create = spawned.find((argv) => argv[1] === "create") ?? [];
    const name = create[create.indexOf("--name") + 1];

    expect(create.slice(create.indexOf("--network"), create.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    expect(create).toContain("--cap-drop");
    expect(create[create.indexOf("--cap-add") + 1]).toBe("NET_BIND_SERVICE");
    expect(create).not.toContain("-v");
    expect(create).not.toContain("--volume");
    expect(create.slice(-4)).toEqual([
      "sha256:abc123",
      "validate",
      "--config",
      "/tmp/cpm-validate.json",
    ]);
    expect(spawned.find((argv) => argv[1] === "rm")).toEqual(["docker", "rm", "--force", name]);
  });

  it("reports a refusal with Caddy's transcript, and leaves no file behind", async () => {
    replies.wait = { exitCode: 0, stdout: "1\n" };
    replies.logs = { exitCode: 0, stdout: "Error: provision http.handlers.waf: nope\n" };
    const result = await new DockerHost(loadConfig()).validateCaddyConfig("{}");
    const local = spawned.find((argv) => argv[1] === "cp")?.[2] ?? "";

    expect(result).toEqual({
      state: "refused",
      output: "Error: provision http.handlers.waf: nope",
    });
    expect(existsSync(local)).toBe(false);
  });

  it("is unavailable, and creates nothing, before Caddy's container exists", async () => {
    replies.inspect = { exitCode: 1, stdout: "Error: No such object" };
    const result = await new DockerHost(loadConfig()).validateCaddyConfig("{}");

    expect(result.state).toBe("unavailable");
    expect(subcommands()).toEqual(["inspect"]);
  });

  it("is unavailable when a refusal's transcript cannot be read", async () => {
    replies.wait = { exitCode: 0, stdout: "1\n" };
    replies.logs = { exitCode: 1, stdout: "Error response from daemon: no such container" };
    const result = await new DockerHost(loadConfig()).validateCaddyConfig("{}");

    expect(result).toEqual({
      state: "unavailable",
      reason: "Error response from daemon: no such container",
    });
    expect(subcommands().at(-1)).toBe("rm");
  });

  it("still accepts on exit 0 when the transcript cannot be read", async () => {
    replies.wait = { exitCode: 0, stdout: "0\n" };
    replies.logs = { exitCode: 1, stdout: "Error response from daemon" };
    const result = await new DockerHost(loadConfig()).validateCaddyConfig("{}");

    expect(result).toEqual({ state: "accepted", output: "" });
  });

  it("removes the container when a step fails", async () => {
    replies.start = { exitCode: 1, stdout: "cannot start" };
    const result = await new DockerHost(loadConfig()).validateCaddyConfig("{}");

    expect(result).toEqual({ state: "unavailable", reason: "cannot start" });
    expect(subcommands()).toEqual(["inspect", "create", "cp", "start", "rm"]);
  });
});

describe("the caddy-validate command", () => {
  type Run = (command: AgentCommand) => Promise<AgentCommandResult>;

  function runner(validation: CaddyValidation, seen: string[]): { run: Run; store: AgentStore } {
    const store = new AgentStore(join(dir, "agent.db"));
    const lifecycle = new AgentLifecycle({
      config: loadConfig(),
      store,
      docker: {
        validateCaddyConfig: async (config: string) => {
          seen.push(config);
          return validation;
        },
      } as unknown as DockerHost,
      operations: {} as Operations,
    });
    const run = (lifecycle as unknown as { runCommand: Run }).runCommand.bind(lifecycle);
    return { run, store };
  }

  it.each([
    [{ state: "accepted", output: "Valid configuration" } as const, 200],
    [{ state: "refused", output: "Error: nope" } as const, CADDY_VALIDATE_REFUSED_STATUS],
  ])("answers %o with status %i", async (validation, status) => {
    const seen: string[] = [];
    const { run, store } = runner(validation, seen);
    const result = await run({ id: "c1", kind: "caddy-validate", request: { config: "{}" } });
    store.close();

    expect(seen).toEqual(["{}"]);
    expect(result).toEqual({
      id: "c1",
      ok: true,
      response: { status, text: validation.output, headers: {} },
    });
  });

  it("fails the command when nothing could be learned, and refuses a missing config", async () => {
    const seen: string[] = [];
    const { run, store } = runner({ state: "unavailable", reason: "no caddy" }, seen);
    const unavailable = await run({ id: "c1", kind: "caddy-validate", request: { config: "{}" } });
    const missing = await run({
      id: "c2",
      kind: "caddy-validate",
      request: {} as unknown as { config: string },
    });
    store.close();

    expect(unavailable).toEqual({ id: "c1", ok: false, code: "BUSY", error: "no caddy" });
    expect(missing).toMatchObject({ id: "c2", ok: false, code: "BAD_REQUEST" });
    expect(seen).toEqual(["{}"]);
  });
});
