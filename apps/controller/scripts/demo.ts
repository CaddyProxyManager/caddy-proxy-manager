/**
 * A container-free demo: DEMO_MODE on, SQLite. `bun run demo [--reset] [--reset-every <hours>]
 * [--prod]`, on :3020. Signs in as admin/admin, which demo mode protects so no visitor can lock
 * out the next; the rest of the environment passes through.
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
  .strict()
  .help()
  .parseSync();

const controllerDir = resolve(import.meta.dir, "..");
// A directory below data/ so the legacy-database scan of ./data skips it.
const dataDir = resolve(args["data-dir"] ?? join(controllerDir, "data", "demo"));
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
};

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
  if (isNew && args.seed) await run([process.execPath, "scripts/seed-demo.ts"]);
}

const vinext = join(controllerDir, "node_modules", "vinext", "dist", "cli.js");
let server: ReturnType<typeof Bun.spawn> | null = null;

function startServer(): void {
  // vinext directly, so stopping it for a reset stops the server, not a wrapper.
  server = Bun.spawn(
    [process.execPath, vinext, args.prod ? "start" : "dev", "--port", String(args.port)],
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
await prepareDatabase(args.reset);
if (args.prod) await run([process.execPath, vinext, "build"]);
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
  const code = await server!.exited;
  process.exit(code ?? 0);
}
