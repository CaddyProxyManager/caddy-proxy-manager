/**
 * A container-free demo: DEMO_MODE on, SQLite. `bun run demo [--reset] [--reset-every <hours>]
 * [--prod] [--first-run]`, on :3020. Signs in as admin/admin, which demo mode protects so no visitor
 * can lock out the next; the rest of the environment passes through. `--first-run` starts from an
 * empty database every launch instead, for working on the setup flow.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const args = yargs(hideBin(process.argv))
  .scriptName("demo")
  .option("port", { type: "number", default: 3020 })
  .option("reset", { type: "boolean", default: false, describe: "Delete and reseed the database" })
  .option("reset-every", { type: "number", describe: "Hours between automatic resets" })
  .option("seed", { type: "boolean", default: true, describe: "Seed a new database (--no-seed)" })
  .option("prod", { type: "boolean", default: false, describe: "Serve a production build" })
  .option("data-dir", { type: "string", describe: "Where the database lives" })
  .option("first-run", {
    type: "boolean",
    default: false,
    describe: "No account and no seed, wiped on every launch: the setup flow",
  })
  .strict()
  .help()
  .parseSync();

const controllerDir = resolve(import.meta.dir, "..");
// A directory below data/ so the legacy-database scan of ./data skips it.
const firstRun = args["first-run"];
const dataDir = resolve(
  args["data-dir"] ?? join(controllerDir, "data", firstRun ? "first-run" : "demo"),
);
const dbFile = join(dataDir, "cpm.db");
mkdirSync(dataDir, { recursive: true });

/** Kept beside the database so sessions survive a restart, but never shared between demos. */
function sessionSecret(): string {
  const file = join(dataDir, "session-secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

const env: Record<string, string | undefined> = {
  ...process.env,
  NODE_ENV: args.prod ? "production" : "development",
  DEMO_MODE: "true",
  DATABASE_URL: `file:${dbFile}`,
  SESSION_SECRET: process.env.SESSION_SECRET || sessionSecret(),
  PORT: String(args.port),
  BASE_URL: process.env.BASE_URL || `http://localhost:${args.port}`,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin",
  // Every visitor shares one account, so a lockout would lock out the demo.
  AUTH_RATE_LIMIT_ENABLED: "false",
  UPDATE_CHECK_ENABLED: "false",
  // vinext allows one dev server per directory; the demo and --first-run each have their own port.
  VINEXT_NO_DEV_LOCK: "1",
};
if (firstRun) {
  // Any of these marks setup complete at startup (lib/setup.ts), and demo mode pins the admin.
  for (const key of ["DEMO_MODE", "ADMIN_USERNAME", "ADMIN_PASSWORD", "OAUTH_ENABLED"]) {
    delete env[key];
  }
}

function deleteDatabase(): void {
  // analytics.db is the demo's traffic (clickhouse/sqlite-store.ts).
  for (const file of [dbFile, join(dataDir, "analytics.db")]) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  }
}

async function run(command: string[]): Promise<void> {
  const code = await Bun.spawn(command, {
    cwd: controllerDir,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`);
}

async function prepareDatabase(fresh: boolean): Promise<void> {
  const isNew = fresh || !existsSync(dbFile);
  if (fresh) deleteDatabase();
  if (isNew && args.seed && !firstRun) await run([process.execPath, "scripts/seed-demo.ts"]);
}

// Vite's own CLI for dev and build, which vinext's now only alias; vinext still serves a build.
const vite = join(controllerDir, "node_modules", "vite", "bin", "vite.js");
const vinext = join(controllerDir, "node_modules", "vinext", "dist", "cli.js");
let server: ReturnType<typeof Bun.spawn> | null = null;

function startServer(): void {
  // The CLI directly, so stopping it for a reset stops the server, not a wrapper.
  server = Bun.spawn(
    args.prod
      ? [process.execPath, vinext, "start", "--port", String(args.port)]
      : [process.execPath, vite, "dev", "--port", String(args.port)],
    { cwd: controllerDir, env, stdio: ["inherit", "inherit", "inherit"] },
  );
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const stopping = server;
  server = null;
  stopping.kill();
  await stopping.exited;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stopServer().finally(() => process.exit(0));
  });
}

console.log(`[demo] ${dbFile}`);
await prepareDatabase(args.reset || firstRun);
if (args.prod) await run([process.execPath, vite, "build"]);
startServer();

if (args["reset-every"]) {
  const every = args["reset-every"] * 60 * 60 * 1000;
  setInterval(async () => {
    console.log("[demo] resetting");
    await stopServer();
    // The server is down while this runs, so nothing holds the file open.
    await prepareDatabase(true);
    startServer();
  }, every);
} else {
  let code = await server!.exited;
  // Finishing setup exits the process to restart it; play the container's supervisor.
  // `server` is cleared by a signal, which TypeScript cannot see from here.
  while (firstRun && code === 0 && (server as typeof server | null)) {
    console.log("[demo] restarting after setup");
    startServer();
    code = await server!.exited;
  }
  process.exit(code ?? 0);
}
