/**
 * The exact argv the agent runs and the state each operation writes. Each invariant is a way a
 * recreate that does slightly too much takes the proxy down.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type AgentConfig, loadConfig } from "../src/config";
import { AgentStore } from "../src/db";
import {
  DockerHost,
  managedServicesEnvFingerprint,
  renderCaddyBuildOverride,
  renderL4PortsOverride,
} from "../src/docker";
import { Operations } from "../src/operations";

let dir: string;
let config: AgentConfig;
let spawned: string[][];
/** Anything unqueued succeeds with empty output. */
let results: Array<{ exitCode: number; stdout?: string }>;
/** The working_dir label, outside the queue so tests don't depend on how many labels are read. */
let hostDirLabel: string;

const realSpawn = Bun.spawn;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-docker-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  delete process.env.COMPOSE_HOST_DIR;
  delete process.env.COMPOSE_EXTRA_FILE;
  delete process.env.COMPOSE_SKIP_OVERRIDE;
  delete process.env.COMPOSE_PROJECT_NAME;
  config = loadConfig();

  spawned = [];
  results = [];
  hostDirLabel = "";
  // The spawn, not DockerHost: a stubbed DockerHost would only assert the test agrees with itself.
  (Bun as { spawn: unknown }).spawn = ((argv: string[]) => {
    spawned.push(argv);
    if (argv.some((a) => a.includes("com.docker.compose.project.working_dir"))) {
      return {
        stdout: new Response(hostDirLabel).body,
        stderr: new Response("").body,
        exited: Promise.resolve(hostDirLabel === "" ? 1 : 0),
      };
    }
    const next = results.shift() ?? { exitCode: 0 };
    return {
      stdout: new Response(next.stdout ?? "").body,
      stderr: new Response("").body,
      exited: Promise.resolve(next.exitCode),
    };
  }) as unknown as typeof Bun.spawn;
});

afterEach(() => {
  (Bun as { spawn: unknown }).spawn = realSpawn;
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

function lastCompose(): string[] {
  const found = [...spawned].reverse().find((a) => a[0] === "docker" && a[1] === "compose");
  if (!found) throw new Error("no compose invocation was made");
  return found;
}

describe("external build mode", () => {
  afterEach(() => {
    delete process.env.CADDY_BUILD_MODE;
  });

  it("never lets compose fall through to a build, which the socket proxy may not allow", async () => {
    process.env.CADDY_BUILD_MODE = "external";
    const host = new DockerHost(loadConfig());
    await host.startCaddy();
    expect(lastCompose()).toContain("--no-build");
    await host.recreateCaddy();
    expect(lastCompose()).toContain("--no-build");
  });

  it("builds on a missing image as before in agent mode", async () => {
    const host = new DockerHost(config);
    await host.startCaddy();
    expect(lastCompose()).not.toContain("--no-build");
  });

  it("pulls a registry tag without failing on a local one, and recreates without building", async () => {
    const host = new DockerHost(config);
    await host.pullCaddyImage();
    expect(lastCompose()).toContain("--ignore-pull-failures");
    await host.upCaddyImage();
    expect(lastCompose()).toContain("--no-build");
    expect(lastCompose()).not.toContain("--force-recreate");
  });

  it("asks compose which image it would create Caddy from", async () => {
    results.push({ exitCode: 0, stdout: "proj" });
    results.push({ exitCode: 0, stdout: "caddy-proxy-manager-caddy:custom\n" });
    expect(await new DockerHost(config).composeCaddyImage()).toBe(
      "caddy-proxy-manager-caddy:custom",
    );
    expect(lastCompose().slice(-3)).toEqual(["config", "--images", "caddy"]);
  });

  it("reads an image's list from a container it never starts, and removes it", async () => {
    await new DockerHost(config).readImageModuleList("caddy-proxy-manager-caddy:custom");
    const verbs = spawned.filter((a) => a[0] === "docker").map((a) => a[1]);
    expect(verbs).toEqual(["create", "cp", "rm"]);
  });

  it("tells a missing module list from a daemon that cannot be read", async () => {
    results.push({
      exitCode: 1,
      stdout: "Error: Could not find the file /etc/caddy/caddy-modules.txt",
    });
    expect(await new DockerHost(config).readCaddyModuleList()).toEqual({ state: "missing" });
    results.push({ exitCode: 1, stdout: "Cannot connect to the Docker daemon" });
    expect((await new DockerHost(config).readCaddyModuleList()).state).toBe("unreadable");
  });
});

describe("compose invocation", () => {
  it("recreates only the caddy service", async () => {
    // A bare `up -d` would recreate this agent partway through its own operation.
    results.push({ exitCode: 0, stdout: "caddy-proxy-manager" });
    await new DockerHost(config).recreateCaddy();
    expect(lastCompose().at(-1)).toBe("caddy");
  });

  it("passes --no-deps so a recreate does not cascade", async () => {
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    expect(lastCompose()).toContain("--no-deps");
  });

  it("passes --force-recreate, without which a port change is a no-op", async () => {
    // Ports are fixed at create time, and compose sees no config change.
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    expect(lastCompose()).toContain("--force-recreate");
  });

  it("passes --pull never, so a recreate cannot swap the image underneath", async () => {
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("--pull") + 1]).toBe("never");
  });

  it("detects the compose project from the caddy container's labels", async () => {
    // It comes from the directory the operator ran compose in, so it cannot be assumed.
    results.push({ exitCode: 0, stdout: "someone-elses-project\n" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("-p") + 1]).toBe("someone-elses-project");
  });

  it("falls back to the default project when the label cannot be read", async () => {
    results.push({ exitCode: 1, stdout: "" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("-p") + 1]).toBe("caddy-proxy-manager");
  });

  it("prefers an explicit project name over detection", async () => {
    process.env.COMPOSE_PROJECT_NAME = "pinned";
    process.env.COMPOSE_HOST_DIR = "/srv/cpm";
    const host = new DockerHost(loadConfig());
    await host.recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("-p") + 1]).toBe("pinned");
    // Never asks Docker, so a stopped Caddy container does not stop a recreate.
    expect(spawned.some((a) => a[1] === "inspect")).toBe(false);
  });

  it("carries both overrides on every invocation", async () => {
    // Omitting either is how a rebuild or a port change silently undoes the other.
    writeFileSync(join(dir, "docker-compose.l4-ports.yml"), renderL4PortsOverride(["25:25"]));
    writeFileSync(
      join(dir, "docker-compose.caddy-build.yml"),
      renderCaddyBuildOverride(["github.com/a/b"]),
    );
    results.push({ exitCode: 0, stdout: "proj" });

    await new DockerHost(config).buildCaddy();
    const argv = lastCompose().join(" ");
    expect(argv).toContain("docker-compose.l4-ports.yml");
    expect(argv).toContain("docker-compose.caddy-build.yml");
  });

  it("detects --project-directory from the host path the operator's compose recorded", async () => {
    // The daemon resolves relative binds against it; without it ./docker/... silently mounts an
    // empty directory Docker created.
    hostDirLabel = "/srv/cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("--project-directory") + 1]).toBe("/srv/cpm");
  });

  it("translates a Windows project directory into the path the daemon can resolve", async () => {
    // Docker Desktop records a drive path, meaningless to the daemon, whose VM mounts each drive
    // at /run/desktop/mnt/host/<letter>.
    hostDirLabel = "C:\\deploy\\cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("--project-directory") + 1]).toBe(
      "/run/desktop/mnt/host/c/deploy/cpm",
    );
  });

  it("translates any drive letter, lowercased", async () => {
    hostDirLabel = "D:\\stacks\\cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("--project-directory") + 1]).toBe(
      "/run/desktop/mnt/host/d/stacks/cpm",
    );
  });

  it("leaves a POSIX label alone", async () => {
    hostDirLabel = "/srv/cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("--project-directory") + 1]).toBe("/srv/cpm");
  });

  it("omits --project-directory for a path it cannot translate", async () => {
    // A UNC path has no mounted drive; the agent logs that COMPOSE_HOST_DIR is needed.
    hostDirLabel = "\\\\server\\share\\cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    expect(lastCompose()).not.toContain("--project-directory");
  });

  it("omits --project-directory when the label cannot be read", async () => {
    // A guess breaks named-volume deployments, where /compose is the right project directory.
    hostDirLabel = "";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    expect(lastCompose()).not.toContain("--project-directory");
  });

  it("prefers an explicit COMPOSE_HOST_DIR over the detected label", async () => {
    hostDirLabel = "/detected";
    process.env.COMPOSE_HOST_DIR = "/srv/cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(loadConfig()).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("--project-directory") + 1]).toBe("/srv/cpm");
  });

  it("builds without --project-directory, even a detected one", async () => {
    // The CLI in this container reads the build context, so a host path fails with "unable to
    // prepare context".
    hostDirLabel = "C:\\deploy\\cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).buildCaddy();
    const argv = lastCompose();
    expect(argv).not.toContain("--project-directory");
    expect(argv.slice(-2)).toEqual(["build", "caddy"]);
    expect(spawned.some((a) => a.some((s) => s.includes("working_dir")))).toBe(false);
  });

  it("builds without --project-directory when COMPOSE_HOST_DIR is pinned", async () => {
    process.env.COMPOSE_HOST_DIR = "/srv/cpm";
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(loadConfig()).buildCaddy();
    const argv = lastCompose();
    expect(argv).not.toContain("--project-directory");
    expect(argv[argv.indexOf("-p") + 1]).toBe("proj");
    expect(argv[argv.indexOf("--env-file") + 1]).toBe("/dev/null");
    expect(argv[argv.indexOf("-f") + 1]).toBe(join(dir, "docker-compose.yml"));
  });

  it("never hands compose the project's .env, even when one is mounted", async () => {
    // It holds the secrets; an explicit empty env file also stops compose reading it implicitly.
    writeFileSync(join(dir, ".env"), "SESSION_SECRET=real\n");
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).recreateCaddy();
    const argv = lastCompose();
    expect(argv[argv.indexOf("--env-file") + 1]).toBe("/dev/null");
    expect(argv).not.toContain(join(dir, ".env"));
  });

  it("interpolates the web-only secrets with placeholders, over the agent's own environment", async () => {
    process.env.SESSION_SECRET = "a-real-secret-that-leaked-into-the-agent";
    const envs: Array<Record<string, string> | undefined> = [];
    const stub = Bun.spawn;
    (Bun as { spawn: unknown }).spawn = ((
      argv: string[],
      options: { env?: Record<string, string> },
    ) => {
      if (argv[1] === "compose") envs.push(options.env);
      return (stub as unknown as (a: string[], o: unknown) => unknown)(argv, options);
    }) as unknown as typeof Bun.spawn;
    try {
      results.push({ exitCode: 0, stdout: "proj" });
      await new DockerHost(config).startService("clickhouse", { CLICKHOUSE_PASSWORD: "pw" });
    } finally {
      delete process.env.SESSION_SECRET;
    }
    const env = envs.at(-1);
    expect(env?.SESSION_SECRET).toBe("unused-by-the-agent");
    expect(env?.POSTGRES_PASSWORD).toBe("unused-by-the-agent");
    expect(env?.CLICKHOUSE_PASSWORD).toBe("pw");
  });

  it("bounds the build with a timeout so a hung compile cannot wedge the agent", async () => {
    // A wedged xcaddy would hold the operation lock, refusing everything else as BUSY.
    // Pinned so no label lookup reaches the stub below, which never exits.
    process.env.COMPOSE_PROJECT_NAME = "proj";
    const host = new DockerHost({ ...loadConfig(), buildTimeoutSeconds: 1 });
    (Bun as { spawn: unknown }).spawn = ((argv: string[], options: { signal?: AbortSignal }) => {
      spawned.push(argv);
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      };
    }) as unknown as typeof Bun.spawn;

    const result = await host.buildCaddy();
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe("published ports", () => {
  it("reads what Docker reports, in compose's own spelling", async () => {
    results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        "443/tcp": [{ HostPort: "443" }],
        "53/udp": [{ HostPort: "53" }],
        "9999/tcp": null,
      }),
    });
    expect(await new DockerHost(config).publishedCaddyPorts()).toEqual(["443:443", "53:53/udp"]);
  });

  it("reads the container's configured bindings, which a stopped Caddy still has", async () => {
    await new DockerHost(config).publishedCaddyPorts();
    expect(spawned.at(-1)).toContain("{{json .HostConfig.PortBindings}}");
  });

  it("reports nothing rather than throwing when the container is gone", async () => {
    results.push({ exitCode: 1, stdout: "" });
    expect(await new DockerHost(config).publishedCaddyPorts()).toEqual([]);
  });
});

describe("operations", () => {
  let store: AgentStore;
  let operations: Operations;

  beforeEach(() => {
    store = new AgentStore(join(dir, "agent.db"));
    operations = new Operations(config, store, new DockerHost(config));
  });

  afterEach(() => {
    store.close();
  });

  it("records the applied module set only once Caddy is healthy again", async () => {
    // Earlier, the controller would emit a handler the still-running old binary rejects.
    const impatient = { ...config, healthTimeoutSeconds: 1 };
    operations = new Operations(impatient, store, new DockerHost(impatient));

    results.push({ exitCode: 0, stdout: "proj" }); // inspect (project)
    results.push({ exitCode: 0 }); // build
    results.push({ exitCode: 0 }); // up
    results.push({ exitCode: 0, stdout: "starting" }); // health, never becomes healthy

    operations.applyCaddyBuild(["github.com/a/b"]);
    await Bun.sleep(1500);

    expect(store.appliedCaddyModules()).toBeNull();
    expect(store.caddyBuildStatus().state).toBe("failed");
  });

  it("leaves the running container alone when the build fails", async () => {
    // The status must say the old image keeps serving: the operator's first question.
    results.push({ exitCode: 0, stdout: "proj" });
    results.push({ exitCode: 1, stdout: "go: module not found" });

    operations.applyCaddyBuild(["github.com/a/b"]);
    await Bun.sleep(100);

    expect(spawned.some((a) => a.includes("up"))).toBe(false);
    expect(store.caddyBuildStatus().message).toContain("left untouched");
    expect(store.appliedCaddyModules()).toBeNull();
  });

  it("builds from the mounted project but recreates against the host one", async () => {
    // Each gets the directory its reader (this container's CLI, the daemon) can see.
    hostDirLabel = "/srv/cpm";
    results.push({ exitCode: 0, stdout: "proj" }); // inspect (project)
    results.push({ exitCode: 0 }); // build
    results.push({ exitCode: 0 }); // up

    operations.applyCaddyBuild(["github.com/a/b"]);
    await Bun.sleep(100);

    const composeCalls = spawned.filter((a) => a[0] === "docker" && a[1] === "compose");
    const build = composeCalls.find((a) => a.includes("build"));
    const up = composeCalls.find((a) => a.includes("up"));
    expect(build).not.toContain("--project-directory");
    expect(up?.[up.indexOf("--project-directory") + 1]).toBe("/srv/cpm");
  });

  it("writes the override before the build reads it", async () => {
    results.push({ exitCode: 0, stdout: "proj" });
    operations.applyCaddyBuild(["github.com/a/b"]);
    await Bun.sleep(50);
    expect(readFileSync(join(dir, "docker-compose.caddy-build.yml"), "utf-8")).toContain(
      'CADDY_MODULES: "github.com/a/b"',
    );
  });

  it("clears a status left mid-flight by a killed agent", async () => {
    // Otherwise the UI spins forever, its button disabled, on an operation that cannot be running.
    store.setCaddyBuildStatus({ state: "building", message: "compiling" });
    store.setL4PortsStatus({ state: "applying", message: "recreating" });

    new Operations(config, store, new DockerHost(config)).clearStaleStatuses();

    expect(store.caddyBuildStatus().state).toBe("failed");
    expect(store.l4PortsStatus().state).toBe("failed");
  });

  it("leaves a finished status alone", async () => {
    store.setCaddyBuildStatus({ state: "applied", message: "done" });
    new Operations(config, store, new DockerHost(config)).clearStaleStatuses();
    expect(store.caddyBuildStatus().state).toBe("applied");
  });

  it("republishes at startup when Caddy came up without the port override", async () => {
    // A plain `docker compose up` has no generated override, so a reboot unpublishes L4 ports.
    store.setAppliedL4Ports(["15432:15432"]);
    results.push({ exitCode: 0, stdout: JSON.stringify({ "80/tcp": [{ HostPort: "80" }] }) });

    await operations.restorePublishedPorts();
    await Bun.sleep(100);

    expect(spawned.some((a) => a.includes("--force-recreate"))).toBe(true);
    expect(readFileSync(join(dir, "docker-compose.l4-ports.yml"), "utf-8")).toContain(
      '"15432:15432"',
    );
  });

  it("does nothing at startup when the published ports already match", async () => {
    store.setAppliedL4Ports(["80:80"]);
    results.push({ exitCode: 0, stdout: JSON.stringify({ "80/tcp": [{ HostPort: "80" }] }) });

    await operations.restorePublishedPorts();
    await Bun.sleep(50);
    // A recreate drops every live connection.
    expect(spawned.some((a) => a.includes("--force-recreate"))).toBe(false);
  });

  it("does nothing at startup when Caddy publishes the base ports beside the applied ones", async () => {
    // 80 and 443 come from docker-compose.yml, never from an apply.
    store.setAppliedL4Ports(["15432:15432"]);
    results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        "80/tcp": [{ HostIp: "", HostPort: "80" }],
        "443/udp": [{ HostIp: "", HostPort: "443" }],
        "15432/tcp": [{ HostIp: "", HostPort: "15432" }],
      }),
    });

    await operations.restorePublishedPorts();
    await Bun.sleep(50);
    expect(spawned.some((a) => a.includes("--force-recreate"))).toBe(false);
  });

  it("matches a recorded range against Docker listing it port by port", async () => {
    // Compared as written, every agent start would recreate Caddy and drop every connection.
    store.setAppliedL4Ports(["5000-5002:5000-5002/udp", "80:80"]);
    results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
        "5000/udp": [
          { HostIp: "0.0.0.0", HostPort: "5000" },
          { HostIp: "::", HostPort: "5000" },
        ],
        "5001/udp": [{ HostPort: "5001" }],
        "5002/udp": [{ HostPort: "5002" }],
      }),
    });

    await operations.restorePublishedPorts();
    await Bun.sleep(50);
    expect(spawned.some((a) => a.includes("--force-recreate"))).toBe(false);
  });

  it("republishes a range Docker publishes only part of", async () => {
    store.setAppliedL4Ports(["5000-5002:5000-5002"]);
    results.push({
      exitCode: 0,
      stdout: JSON.stringify({
        "5000/tcp": [{ HostPort: "5000" }],
        "5001/tcp": [{ HostPort: "5001" }],
      }),
    });

    await operations.restorePublishedPorts();
    await Bun.sleep(100);

    expect(spawned.some((a) => a.includes("--force-recreate"))).toBe(true);
    expect(readFileSync(join(dir, "docker-compose.l4-ports.yml"), "utf-8")).toContain(
      '"5000-5002:5000-5002"',
    );
  });

  it("records nothing when it has never applied anything", async () => {
    // Adopting Docker's 80 and 443 made the first desired state recreate Caddy to drop them.
    results.push({ exitCode: 0, stdout: JSON.stringify({ "443/tcp": [{ HostPort: "443" }] }) });

    await operations.restorePublishedPorts();
    await Bun.sleep(50);

    expect(store.appliedL4Ports()).toEqual([]);
    expect(spawned.some((a) => a.includes("--force-recreate"))).toBe(false);
  });
});

describe("optional services", () => {
  let store: AgentStore;
  let operations: Operations;

  beforeEach(() => {
    store = new AgentStore(join(dir, "agent.db"));
    operations = new Operations(config, store, new DockerHost(config));
  });

  afterEach(() => {
    store.close();
  });

  /** The operation returns as soon as the work is accepted. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 100 && store.managedServicesStatus().state === "applying"; i++) {
      await Bun.sleep(10);
    }
  }

  it("enables the profile explicitly rather than relying on compose to infer it", async () => {
    // Otherwise "no such service"; only some v2 releases infer it.
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).startService("clickhouse");

    const argv = lastCompose();
    expect(argv[argv.indexOf("--profile") + 1]).toBe("clickhouse");
    // Top-level flag: compose rejects it after the subcommand.
    expect(argv.indexOf("--profile")).toBeLessThan(argv.indexOf("up"));
    expect(argv.at(-1)).toBe("clickhouse");
  });

  it("stops rather than removes, so the data volume outlives the toggle", async () => {
    results.push({ exitCode: 0, stdout: "proj" });
    await new DockerHost(config).stopService("clickhouse");

    const argv = lastCompose();
    expect(argv).toContain("stop");
    expect(argv).not.toContain("down");
    expect(argv).not.toContain("rm");
  });

  it("passes the credentials through the child's environment, not a file on disk", async () => {
    // The environment outranks any env file, so it beats a stale read-only .env, keeps the
    // password off the data volume and needs no quoting.
    writeFileSync(join(dir, ".env"), "CLICKHOUSE_PASSWORD=stale\n");
    let seen: Record<string, string> | undefined;
    (Bun as { spawn: unknown }).spawn = ((
      argv: string[],
      opts: { env?: Record<string, string> },
    ) => {
      spawned.push(argv);
      if (argv[1] === "compose") seen = opts.env;
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    await new DockerHost(config).startService("clickhouse", { CLICKHOUSE_PASSWORD: "pa$$#word'x" });

    expect(seen?.CLICKHOUSE_PASSWORD).toBe("pa$$#word'x");
    // Inherited too, or `docker` cannot find the socket proxy.
    expect(seen?.DATA_DIR).toBe(dir);
    expect(existsSync(join(dir, "fleet.env"))).toBe(false);
  });

  it("hands the credentials to a stop as well as a start", async () => {
    // Compose parses the whole file, including the ${...:?} guard on a service it is not touching.
    let seen: Record<string, string> | undefined;
    (Bun as { spawn: unknown }).spawn = ((
      argv: string[],
      opts: { env?: Record<string, string> },
    ) => {
      spawned.push(argv);
      if (argv[1] === "compose") seen = opts.env;
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    await new DockerHost(config).stopService("clickhouse", { CLICKHOUSE_PASSWORD: "s3cret" });
    expect(seen?.CLICKHOUSE_PASSWORD).toBe("s3cret");
  });

  it("starts what was asked for", async () => {
    operations.applyManagedServices({ services: { clickhouse: true }, env: {} });
    await settle();

    const composeCalls = spawned.filter((a) => a[1] === "compose").map((a) => a.join(" "));
    expect(composeCalls.some((c) => c.includes("--profile clickhouse") && c.includes(" up "))).toBe(
      true,
    );
    expect(store.appliedManagedServices()).toEqual({ clickhouse: true, crowdsec: false });
  });

  it("stops what was not asked for", async () => {
    operations.applyManagedServices({ services: { clickhouse: false }, env: {} });
    await settle();

    const composeCalls = spawned.filter((a) => a[1] === "compose").map((a) => a.join(" "));
    expect(
      composeCalls.some((c) => c.includes("--profile clickhouse") && c.includes(" stop ")),
    ).toBe(true);
    expect(store.appliedManagedServices()).toEqual({ clickhouse: false, crowdsec: false });
  });

  it("leaves alone a service it no longer manages", async () => {
    // An older controller still names geoipupdate, whose service the compose file no longer has.
    operations.applyManagedServices({
      services: { clickhouse: false, geoipupdate: true } as { clickhouse: boolean },
      env: {},
    });
    await settle();

    const composeCalls = spawned.filter((a) => a[1] === "compose").map((a) => a.join(" "));
    expect(composeCalls.some((c) => c.includes("geoipupdate"))).toBe(false);
  });

  it("records a service that failed to start as not applied", async () => {
    results.push({ exitCode: 0, stdout: "proj" }); // project detection
    results.push({ exitCode: 1, stdout: "no such image" }); // clickhouse up

    operations.applyManagedServices({ services: { clickhouse: true }, env: {} });
    await settle();

    const status = store.managedServicesStatus();
    expect(status.state).toBe("failed");
    expect(status.message).toContain("clickhouse");
    expect(store.appliedManagedServices()).toEqual({ clickhouse: false, crowdsec: false });
  });

  it("starts crowdsec under its own profile, with the bouncer key in the child's environment", async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    (Bun as { spawn: unknown }).spawn = ((
      argv: string[],
      opts: { env?: Record<string, string> },
    ) => {
      spawned.push(argv);
      if (argv[1] === "compose") calls.push({ argv, env: opts.env });
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    operations.applyManagedServices({
      services: { crowdsec: true },
      env: { CROWDSEC_BOUNCER_KEY: "k".repeat(64), CROWDSEC_DISABLE_ONLINE_API: "true" },
    });
    await settle();

    const up = calls.find((c) => c.argv.includes("up"));
    expect(up?.argv[up.argv.indexOf("--profile") + 1]).toBe("crowdsec");
    expect(up?.argv.at(-1)).toBe("crowdsec");
    expect(up?.env?.CROWDSEC_BOUNCER_KEY).toBe("k".repeat(64));
    expect(up?.env?.CROWDSEC_DISABLE_ONLINE_API).toBe("true");
    // The key is never an argument, where `ps` would show it.
    expect(calls.some((c) => c.argv.join(" ").includes("k".repeat(64)))).toBe(false);
    expect(store.appliedManagedServices()).toEqual({ clickhouse: false, crowdsec: true });
  });

  it("reads stopping a service an older compose file lacks as stopped", async () => {
    results.push({ exitCode: 0, stdout: "proj" }); // project detection
    results.push({ exitCode: 0 }); // clickhouse stop
    results.push({ exitCode: 1, stdout: "no such service: crowdsec" }); // crowdsec stop

    operations.applyManagedServices({ services: {}, env: {} });
    await settle();

    expect(store.managedServicesStatus().state).toBe("applied");
    expect(store.appliedManagedServices()).toEqual({ clickhouse: false, crowdsec: false });
  });

  it("still fails starting a service an older compose file lacks", async () => {
    results.push({ exitCode: 0, stdout: "proj" });
    results.push({ exitCode: 0 });
    results.push({ exitCode: 1, stdout: "no such service: crowdsec" });

    operations.applyManagedServices({ services: { crowdsec: true }, env: {} });
    await settle();

    expect(store.managedServicesStatus().state).toBe("failed");
    expect(store.appliedManagedServices()).toEqual({ clickhouse: false, crowdsec: false });
  });

  it("records a digest of what it was given, never the values", async () => {
    const env = { CROWDSEC_BOUNCER_KEY: "secret-bouncer-key" };
    operations.applyManagedServices({ services: {}, env });
    await settle();

    expect(store.appliedManagedServicesEnv()).toBe(managedServicesEnvFingerprint(env));
    expect(store.appliedManagedServicesEnv()).not.toContain("secret-bouncer-key");
    expect(managedServicesEnvFingerprint(env)).not.toBe(managedServicesEnvFingerprint({}));
  });

  it("refuses to run alongside a rebuild", async () => {
    operations.applyCaddyBuild(["github.com/a/b"]);
    expect(() =>
      operations.applyManagedServices({ services: { clickhouse: true }, env: {} }),
    ).toThrow(/caddy-build/);
  });
});
