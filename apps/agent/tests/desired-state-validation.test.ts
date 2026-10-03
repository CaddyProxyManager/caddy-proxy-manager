/**
 * The agent re-checks desired state: it holds the Docker socket, so a compromised or on-path
 * controller must not turn a field into a privileged container or hijacked `docker` child.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  expandL4PortMappings,
  isValidL4PortMapping,
  isValidModuleSpec,
  sameL4PortSet,
} from "@cpm/shared";
import { type AgentConfig, loadConfig } from "../src/config";
import { AgentStore } from "../src/db";
import {
  BUILD_OVERRIDE_FILE,
  composeEnv,
  DockerHost,
  L4_OVERRIDE_FILE,
  renderCaddyBuildOverride,
  renderL4PortsOverride,
} from "../src/docker";
import { Operations } from "../src/operations";

/** Closes the quoted scalar the old renderer wrote and adds keys to the caddy service. */
const EVIL_PORT = '80:80"\n    privileged: true\n    pid: host\n    volumes: ["/:/host"]\n    x: "';
const EVIL_MODULE = 'github.com/a/b"\n    privileged: true\n    x: "';

const yaml = (Bun as unknown as { YAML: { parse(text: string): unknown } }).YAML;

let dir: string;
let config: AgentConfig;
let spawned: Array<{ argv: string[]; env?: Record<string, string> }>;
const realSpawn = Bun.spawn;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-validation-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.AGENT_MODE = "standalone";
  // So composeArgs asks Docker nothing and every spawn is one under test.
  process.env.COMPOSE_PROJECT_NAME = "proj";
  process.env.COMPOSE_HOST_DIR = "/srv/cpm";
  delete process.env.COMPOSE_EXTRA_FILE;
  delete process.env.COMPOSE_SKIP_OVERRIDE;
  config = { ...loadConfig(), healthTimeoutSeconds: 1 };

  spawned = [];
  (Bun as { spawn: unknown }).spawn = ((
    argv: string[],
    options: { env?: Record<string, string> },
  ) => {
    spawned.push({ argv, env: options?.env });
    return {
      stdout: new Response("healthy").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    };
  }) as unknown as typeof Bun.spawn;
});

afterEach(() => {
  (Bun as { spawn: unknown }).spawn = realSpawn;
  delete process.env.COMPOSE_PROJECT_NAME;
  delete process.env.COMPOSE_HOST_DIR;
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

describe("shared validators", () => {
  it("accepts the port mappings the controller and docker inspect produce", () => {
    for (const port of [
      "80:80",
      "53:53/udp",
      "443:443/tcp",
      "1:1",
      "65535:65535",
      "5000-5010:5000-5010",
      "5000-5010:6000-6010/udp",
      "1-65535:1-65535",
    ]) {
      expect(isValidL4PortMapping(port)).toBe(true);
    }
  });

  it("expands a range the way docker inspect lists it, for comparing sets", () => {
    expect(expandL4PortMappings(["5001-5002:5001-5002/udp", "80:80/tcp", "80:80"])).toEqual([
      "5001:5001/udp",
      "5002:5002/udp",
      "80:80",
    ]);
    expect(sameL4PortSet(["5000-5001:5000-5001"], ["5001:5001", "5000:5000"])).toBe(true);
    expect(sameL4PortSet(["5000-5001:5000-5001"], ["5000:5000"])).toBe(false);
    // Kept, so an entry the apply would refuse still reads as a change.
    expect(sameL4PortSet([EVIL_PORT], [])).toBe(false);
  });

  it("rejects anything else", () => {
    for (const port of [
      EVIL_PORT,
      "0:80",
      "80:65536",
      "80",
      "80:80/sctp",
      "127.0.0.1:80:80",
      "80:80 ",
      "80-90:80-95",
      "90-80:90-80",
      "80-80-90:80-80-90",
      "0-10:0-10",
      "65535-65536:65535-65536",
      "80-:80-",
      "",
    ]) {
      expect(isValidL4PortMapping(port)).toBe(false);
    }
  });

  it("accepts built-in and pinned custom module specs", () => {
    for (const spec of [
      "github.com/caddy-dns/cloudflare",
      "github.com/corazawaf/coraza-caddy/v2",
      "github.com/greenpau/caddy-security@v1.2.3",
    ]) {
      expect(isValidModuleSpec(spec)).toBe(true);
    }
  });

  it("rejects module specs that could reach the Dockerfile's shell", () => {
    for (const spec of [
      EVIL_MODULE,
      "caddy-l4",
      "github.com/a/b c",
      "github.com/a/b;id",
      "$(id)/x",
      "github.com/a/b@",
      "github.com/a/b@v1@v2",
      `github.com/${"a".repeat(200)}`,
    ]) {
      expect(isValidModuleSpec(spec)).toBe(false);
    }
  });
});

describe("rendered overrides", () => {
  it("keep a hostile port inside one scalar", () => {
    expect(yaml.parse(renderL4PortsOverride([EVIL_PORT, "53:53/udp"]))).toEqual({
      services: { caddy: { ports: [EVIL_PORT, "53:53/udp"] } },
    });
  });

  it("keep a hostile module list inside one build arg", () => {
    expect(yaml.parse(renderCaddyBuildOverride([EVIL_MODULE, "github.com/x/y"]))).toEqual({
      services: { caddy: { build: { args: { CADDY_MODULES: `${EVIL_MODULE} github.com/x/y` } } } },
    });
  });

  it("round-trip a range, so a port override with one is not removed as stale", async () => {
    writeFileSync(join(dir, L4_OVERRIDE_FILE), renderL4PortsOverride(["5000-5010:5000-5010/udp"]));
    await new DockerHost(config).recreateCaddy();

    const argv = spawned.find((s) => s.argv[1] === "compose")?.argv.join(" ") ?? "";
    expect(argv).toContain(L4_OVERRIDE_FILE);
    expect(yaml.parse(readFileSync(join(dir, L4_OVERRIDE_FILE), "utf-8"))).toEqual({
      services: { caddy: { ports: ["5000-5010:5000-5010/udp"] } },
    });
  });

  it("spell valid entries exactly as before, so existing files still round-trip", () => {
    expect(renderL4PortsOverride(["15432:15432"])).toContain('\n      - "15432:15432"\n');
    expect(renderCaddyBuildOverride(["github.com/a/b", "github.com/c/d"])).toContain(
      '\n        CADDY_MODULES: "github.com/a/b github.com/c/d"\n',
    );
  });
});

describe("operations refuse an invalid frame", () => {
  let store: AgentStore;
  let operations: Operations;

  beforeEach(() => {
    store = new AgentStore(join(dir, "agent.db"));
    operations = new Operations(config, store, new DockerHost(config));
  });

  afterEach(() => {
    store.close();
  });

  it("publishes nothing when one port is malicious", async () => {
    store.setAppliedL4Ports(["443:443"]);
    operations.applyL4Ports(["80:80", EVIL_PORT]);
    await Bun.sleep(50);

    expect(spawned).toHaveLength(0);
    expect(existsSync(join(dir, L4_OVERRIDE_FILE))).toBe(false);
    expect(store.l4PortsStatus().state).toBe("failed");
    expect(store.l4PortsStatus().error).toContain("Invalid port mapping");
    expect(store.appliedL4Ports()).toEqual(["443:443"]);
    // The refusal took no lock.
    expect(() => operations.applyCaddyBuild(["github.com/a/b"])).not.toThrow();
  });

  it("builds nothing when one module is malicious", async () => {
    operations.applyCaddyBuild(["github.com/a/b", EVIL_MODULE]);
    await Bun.sleep(50);

    expect(spawned).toHaveLength(0);
    expect(existsSync(join(dir, BUILD_OVERRIDE_FILE))).toBe(false);
    expect(store.caddyBuildStatus().state).toBe("failed");
    expect(store.caddyBuildStatus().error).toContain("Invalid module spec");
    expect(store.appliedCaddyModules()).toBeNull();
  });

  it("never hands a non-allowlisted variable to docker", async () => {
    operations.applyManagedServices({
      services: { clickhouse: true },
      env: {
        CLICKHOUSE_PASSWORD: "s3cret",
        DOCKER_HOST: "tcp://attacker:2375",
        LD_PRELOAD: "/tmp/x.so",
      } as Record<string, string>,
    });
    for (let i = 0; i < 100 && store.managedServicesStatus().state === "applying"; i++) {
      await Bun.sleep(10);
    }

    const compose = spawned.filter((s) => s.argv[1] === "compose");
    expect(compose.length).toBeGreaterThan(0);
    for (const call of compose) {
      expect(call.env?.CLICKHOUSE_PASSWORD).toBe("s3cret");
      expect(call.env?.DOCKER_HOST).toBe(process.env.DOCKER_HOST);
      expect(call.env?.LD_PRELOAD).toBe(process.env.LD_PRELOAD);
    }
  });

  it("fails the services operation on a value with a line break", async () => {
    operations.applyManagedServices({
      services: { clickhouse: true },
      env: { CLICKHOUSE_PASSWORD: "a\nEVIL=1" },
    });
    for (let i = 0; i < 100 && store.managedServicesStatus().state === "applying"; i++) {
      await Bun.sleep(10);
    }

    expect(spawned.filter((s) => s.argv[1] === "compose")).toHaveLength(0);
    const status = store.managedServicesStatus();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("CLICKHOUSE_PASSWORD");
    expect(status.error).not.toContain("EVIL");
  });
});

describe("composeEnv", () => {
  it("keeps only MANAGED_SERVICE_ENV_KEYS", () => {
    expect(
      composeEnv({
        CLICKHOUSE_USER: "cpm",
        GEOIPUPDATE_LICENSE_KEY: "",
        DOCKER_HOST: "tcp://attacker:2375",
        DOCKER_CONFIG: "/tmp",
        PATH: "/tmp",
        COMPOSE_PROFILES: "all",
        PUID: "0",
      } as Record<string, string>),
    ).toEqual({ CLICKHOUSE_USER: "cpm" });
  });

  it("rejects a NUL or carriage return as well as a newline", () => {
    expect(() => composeEnv({ CLICKHOUSE_DB: "a\0b" })).toThrow(/CLICKHOUSE_DB/);
    expect(() => composeEnv({ CLICKHOUSE_DB: "a\rb" })).toThrow(/CLICKHOUSE_DB/);
  });
});

describe("stale override files", () => {
  it("removes a port override this agent would not have written, and leaves it out", async () => {
    // What the unescaped renderer produced for EVIL_PORT, still on disk from before the fix.
    const legacy = renderL4PortsOverride(["80:80"]).replace(
      '      - "80:80"',
      '      - "80:80"\n    privileged: true',
    );
    writeFileSync(join(dir, L4_OVERRIDE_FILE), legacy);

    await new DockerHost(config).recreateCaddy();

    const argv = spawned.find((s) => s.argv[1] === "compose")?.argv.join(" ") ?? "";
    expect(argv).not.toContain(L4_OVERRIDE_FILE);
    expect(existsSync(join(dir, L4_OVERRIDE_FILE))).toBe(false);
  });

  it("removes a build override with an invalid module", async () => {
    writeFileSync(join(dir, BUILD_OVERRIDE_FILE), renderCaddyBuildOverride(["$(id)/x"]));
    await new DockerHost(config).buildCaddy();

    const argv = spawned.find((s) => s.argv[1] === "compose")?.argv.join(" ") ?? "";
    expect(argv).not.toContain(BUILD_OVERRIDE_FILE);
    expect(existsSync(join(dir, BUILD_OVERRIDE_FILE))).toBe(false);
  });

  it("keeps valid overrides, including the empty ones", async () => {
    writeFileSync(join(dir, L4_OVERRIDE_FILE), renderL4PortsOverride([]));
    writeFileSync(join(dir, BUILD_OVERRIDE_FILE), renderCaddyBuildOverride(["github.com/a/b"]));
    await new DockerHost(config).recreateCaddy();

    const argv = spawned.find((s) => s.argv[1] === "compose")?.argv.join(" ") ?? "";
    expect(argv).toContain(L4_OVERRIDE_FILE);
    expect(argv).toContain(BUILD_OVERRIDE_FILE);
    expect(readFileSync(join(dir, L4_OVERRIDE_FILE), "utf-8")).toBe(renderL4PortsOverride([]));
  });
});
