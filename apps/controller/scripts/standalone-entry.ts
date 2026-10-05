/**
 * Compiled-binary entry. vinext's own server.js finds its build output via `import.meta.dirname`,
 * which `bun build --compile` freezes to the build machine's path; this uses `process.execPath`.
 */
import { Server } from "node:http";
import { dirname, join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import pkg from "../package.json";
import { installPeerAddressStamp } from "../src/lib/http/peer-address";
import {
  CONSOLE_ENABLE_USER_PATH,
  CONSOLE_RESET_TWO_FACTOR_PATH,
  type ConsoleCommandPurpose,
  signConsoleCommand,
} from "../src/lib/users/console-command";

function resolveAppRoot(): string {
  return process.env.CPM_APP_ROOT?.trim() || dirname(process.execPath);
}

/** No curl in the image, so the HEALTHCHECK probes with the binary itself. */
function runHealthCheck(port: number): void {
  const url = process.env.CPM_HEALTHCHECK_URL ?? `http://127.0.0.1:${port}/api/health`;
  fetch(url, { signal: AbortSignal.timeout(5_000) })
    .then((response) => process.exit(response.ok ? 0 : 1))
    .catch(() => process.exit(1));
}

/**
 * Asks the running server rather than writing the database, so the change is audited and SQLite
 * never has a second writer. Console output, so English.
 */
function postConsoleCommand(
  port: number,
  path: string,
  purpose: ConsoleCommandPurpose,
  username: string,
): Promise<Response> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error("[cpm] SESSION_SECRET is not set. Run this inside the web container.");
    process.exit(2);
  }
  const timestamp = Date.now();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      timestamp,
      signature: signConsoleCommand(secret, username, timestamp, purpose),
    }),
    signal: AbortSignal.timeout(15_000),
  });
}

function runEnableUser(port: number, username: string): void {
  postConsoleCommand(port, CONSOLE_ENABLE_USER_PATH, "enable-user", username)
    .then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as {
        email?: string;
        wasDisabled?: boolean;
        error?: string;
      };
      if (!response.ok) {
        console.error(`[cpm] Enable refused: ${body.error ?? response.status}`);
        process.exit(1);
      }
      console.log(
        body.wasDisabled
          ? `[cpm] Enabled ${body.email}. Its count of failed sign-ins starts over.`
          : `[cpm] ${body.email} was not disabled; its count of failed sign-ins starts over.`,
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error("[cpm] Could not reach the running server:", error);
      process.exit(1);
    });
}

function runResetTwoFactor(port: number, username: string): void {
  postConsoleCommand(port, CONSOLE_RESET_TWO_FACTOR_PATH, "reset-2fa", username)
    .then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as {
        email?: string;
        hadTwoFactor?: boolean;
        passkeysRemoved?: number;
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
      if (body.passkeysRemoved) {
        console.log(`[cpm] Removed ${body.passkeysRemoved} passkey(s) for ${body.email} too.`);
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error("[cpm] Could not reach the running server:", error);
      process.exit(1);
    });
}

/**
 * `bun build --compile` keeps argv's two-element prefix, so `hideBin` still applies. The version
 * is the manifest's; a release tag reaches only the UI (a Vite `define`), so the two can differ.
 */
const argv = yargs(hideBin(process.argv))
  .scriptName("cpm-server")
  .usage("$0 [options]\n\nRuns the Caddy Proxy Manager web server.")
  .option("host", {
    type: "string",
    // A dual-stack `::` accepts IPv4 too; 0.0.0.0 would leave IPv6-only clients out.
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
    describe:
      "Turn off two-factor sign-in and remove the passkeys of a user on the running server, then exit",
  })
  .option("enable-user", {
    type: "string",
    describe:
      "Enable a disabled user on the running server and start their failed sign-ins over, then exit",
  })
  .version(pkg.version)
  // A mistyped HEALTHCHECK flag would otherwise start a second server that reports healthy.
  .strict()
  .help()
  .parseSync();

if (!Number.isInteger(argv.port) || argv.port < 1 || argv.port > 65535) {
  console.error(`[cpm] --port must be a number between 1 and 65535, got "${argv.port}"`);
  process.exit(2);
}

if (argv["reset-2fa"] !== undefined) {
  runResetTwoFactor(argv.port, argv["reset-2fa"]);
} else if (argv["enable-user"] !== undefined) {
  runEnableUser(argv.port, argv["enable-user"]);
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
