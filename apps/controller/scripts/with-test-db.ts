/**
 * `bun scripts/with-test-db.ts bun test tests/unit`. Starts a throwaway PostgreSQL so a fresh
 * clone can test; an existing TEST_POSTGRES_URL (CI's service container) or TEST_DB=sqlite
 * starts none.
 */
import { SQL } from "bun";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const IMAGE = "postgres:18-alpine";
const CONTAINER = `cpm-test-db-${process.pid}`;
const PASSWORD = "cpm-test";
const READY_TIMEOUT_MS = 60_000;

/**
 * `halt-at-non-option` leaves the child's flags (`bun test --parallel`) to it, and positional
 * numbers stay strings so `007` does not arrive as `7`.
 */
const command = yargs(hideBin(process.argv))
  .scriptName("with-test-db")
  .usage("Usage: $0 <command> [args...]")
  .parserConfiguration({ "halt-at-non-option": true, "parse-positional-numbers": false })
  .demandCommand(1, "a command to run is required")
  // Exit 2: yargs's 1 is indistinguishable from the wrapped command failing.
  .fail((message, error) => {
    if (error) throw error;
    console.error(message);
    process.exit(2);
  })
  .help()
  .parseSync()
  ._.map(String);

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Port 0 lets the OS pick, so concurrent runs never collide. */
async function startContainer(): Promise<string> {
  const run = await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-e",
    "POSTGRES_USER=cpm",
    "-e",
    "POSTGRES_DB=cpm_test",
    "-p",
    "0:5432",
    // The parent: 18+ refuses a separate mount at the old /var/lib/postgresql/data.
    "--tmpfs",
    "/var/lib/postgresql",
    IMAGE,
    // Every parallel test process opens its own pool; the default 100 runs out.
    "-c",
    "max_connections=1000",
    // Throwaway, and fsync is the largest cost in schema setup and teardown.
    "-c",
    "fsync=off",
    "-c",
    "full_page_writes=off",
    "-c",
    "synchronous_commit=off",
  ]);
  if (run.code !== 0) {
    throw new Error(`Could not start ${IMAGE}: ${run.stderr || run.stdout}`);
  }

  const port = await docker(["port", CONTAINER, "5432/tcp"]);
  if (port.code !== 0) {
    throw new Error(`Could not read the container's port: ${port.stderr || port.stdout}`);
  }
  // "0.0.0.0:49154", and on some daemons an IPv6 line follows.
  const mapped = port.stdout.split("\n")[0]?.trim().split(":").pop();
  if (!mapped) {
    throw new Error(`Could not parse the container's port from: ${port.stdout}`);
  }
  return mapped;
}

/** Returns max_connections, proof the -c flags reached postgres. */
async function waitUntilReady(url: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const probe = new SQL({ url, max: 1 });
    try {
      const [row] = await probe.unsafe("SHOW max_connections");
      await probe.close();
      return String((row as { max_connections: string }).max_connections);
    } catch (error) {
      lastError = error;
      await probe.close().catch(() => {});
      await Bun.sleep(250);
    }
  }
  throw new Error(`PostgreSQL was not ready within ${READY_TIMEOUT_MS}ms: ${lastError}`);
}

let started = false;

async function stopContainer(): Promise<void> {
  if (!started) return;
  started = false;
  await docker(["rm", "-f", CONTAINER]);
}

let url = process.env.TEST_POSTGRES_URL;

if (process.env.TEST_DB === "sqlite") {
  // In-memory per test (tests/helpers/db.ts); nothing to start.
  console.log("[test-db] SQLite, in memory");
} else if (url) {
  console.log("[test-db] using TEST_POSTGRES_URL from the environment");
} else {
  const port = await startContainer();
  started = true;
  url = `postgres://cpm:${PASSWORD}@127.0.0.1:${port}/cpm_test`;
  // `--rm` only covers the container exiting on its own, not Ctrl-C here.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopContainer().finally(() => process.exit(130));
    });
  }
  const limit = await waitUntilReady(url);
  console.log(`[test-db] ${IMAGE} on 127.0.0.1:${port}, max_connections=${limit}`);
}

const child = Bun.spawn(command, {
  env: url ? { ...process.env, TEST_POSTGRES_URL: url } : process.env,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

const code = await child.exited;
await stopContainer();
process.exit(code);
