/**
 * Entry point for the compiled server binary. `vinext build` emits its own
 * dist/standalone/server.js, but that cannot be the compile entry: it locates the build output with
 * `import.meta.dirname`, which `bun build --compile` freezes to the build machine's path. This uses
 * `process.execPath` instead. The app bundle stays outside the compiled graph, read from disk.
 */
import { Server } from "node:http";
import { dirname, join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import pkg from "../package.json";
import { installPeerAddressStamp } from "../src/lib/peer-address";
import { CONSOLE_RESET_TWO_FACTOR_PATH, signConsoleCommand } from "../src/lib/console-command";

/** Directory holding the build output (`dist/`) and its runtime dependencies. */
function resolveAppRoot(): string {
  return process.env.CPM_APP_ROOT?.trim() || dirname(process.execPath);
}

/** `--healthcheck` for the container HEALTHCHECK - no curl in the image, so it self-probes. */
function runHealthCheck(port: number): void {
  const url = process.env.CPM_HEALTHCHECK_URL ?? `http://127.0.0.1:${port}/api/health`;
  fetch(url, { signal: AbortSignal.timeout(5_000) })
    .then((response) => process.exit(response.ok ? 0 : 1))
    .catch(() => process.exit(1));
}

/**
 * `--reset-2fa <username>`: asks the running server rather than writing the database, so the reset
 * is audited and a SQLite database never has a second writer. Console output, so English.
 */
function runResetTwoFactor(port: number, username: string): void {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error("[cpm] SESSION_SECRET is not set. Run this inside the web container.");
    process.exit(2);
  }
  const timestamp = Date.now();
  fetch(`http://127.0.0.1:${port}${CONSOLE_RESET_TWO_FACTOR_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      timestamp,
      signature: signConsoleCommand(secret, username, timestamp),
    }),
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as {
        email?: string;
        hadTwoFactor?: boolean;
        error?: string;
      };
      if (!response.ok) {
        console.error(`[cpm] Reset refused: ${body.error ?? response.status}`);
        process.exit(1);
      }
      console.log(
        body.hadTwoFactor
          ? `[cpm] Two-factor sign-in reset for ${body.email}. They can sign in with their password and set it up again.`
          : `[cpm] ${body.email} had no two-factor sign-in; nothing to reset. Their sessions were ended.`,
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error("[cpm] Could not reach the running server:", error);
      process.exit(1);
    });
}

/**
 * `hideBin` is correct for the compiled binary too: `bun build --compile` keeps argv's two-element
 * prefix. The version is the workspace manifest's, bundled at compile time - a release image's tag
 * reaches the UI through a Vite `define` that never runs over this file, so the two can differ on a
 * tagged build.
 */
const argv = yargs(hideBin(process.argv))
  .scriptName("cpm-server")
  .usage("$0 [options]\n\nRuns the Caddy Proxy Manager web server.")
  .option("host", {
    type: "string",
    // `::` rather than `0.0.0.0`: a dual-stack socket accepts IPv4 too, so this binds both
    // families, while 0.0.0.0 binds only one and leaves an IPv6-only client with nothing to
    // connect to.
    default: process.env.HOST ?? "::",
    defaultDescription: "$HOST, else :: (dual-stack)",
    describe: "Address to bind",
  })
  .option("port", {
    type: "number",
    default: Number.parseInt(process.env.PORT ?? "3000", 10),
    defaultDescription: "$PORT, else 3000",
    describe: "Port to listen on",
  })
  .option("healthcheck", {
    type: "boolean",
    default: false,
    describe: "Probe the running server's /api/health, then exit 0 if it answered",
  })
  .option("reset-2fa", {
    type: "string",
    describe: "Turn off two-factor sign-in for a user on the running server, then exit",
  })
  .version(pkg.version)
  // A mistyped flag in the container's HEALTHCHECK would otherwise fall through and start a second
  // server, which binds nothing and reports healthy.
  .strict()
  .help()
  .parseSync();

if (!Number.isInteger(argv.port) || argv.port < 1 || argv.port > 65535) {
  console.error(`[cpm] --port must be a number between 1 and 65535, got "${argv.port}"`);
  process.exit(2);
}

if (argv["reset-2fa"] !== undefined) {
  runResetTwoFactor(argv.port, argv["reset-2fa"]);
} else if (argv.healthcheck) {
  // The resolved port, so probing a server started with --port still reaches it.
  runHealthCheck(argv.port);
} else {
  // Before the server exists: the client IP behind every login throttle comes from this stamp.
  installPeerAddressStamp(Server);
  startProdServer({
    port: argv.port,
    host: argv.host,
    outDir: join(resolveAppRoot(), "dist"),
  }).catch((error) => {
    console.error("[cpm] Failed to start the server");
    console.error(error);
    process.exit(1);
  });
}
