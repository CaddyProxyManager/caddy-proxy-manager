/**
 * Bun is the only supported runtime: the database layer uses `Bun.SQL`. Under Node the
 * process dies while linking on an unsupported `bun:` URL, which reads as a packaging bug - so say
 * so plainly, and say what to run.
 */

/** `{runtime}` is filled in by describeRuntime() at the point of failure. */
export const BUN_REQUIRED_MESSAGE = [
  "Caddy Proxy Manager requires the Bun runtime, but this process is running under {runtime}.",
  "",
  "Start it with Bun instead:",
  "  bun server.js   (production / standalone build)",
  "  bun run dev     (development)",
  "",
  "Install Bun from https://bun.sh, or use the published Docker image, which already runs Bun.",
].join("\n");

/** Names the current runtime for the error message. */
export function describeRuntime(): string {
  return process.versions.node ? `Node.js ${process.versions.node}` : "an unknown runtime";
}

/**
 * Aborts unless running under Bun. Covers the paths where app code runs at all; the standalone
 * build fails earlier, while linking, so inject-runtime-guard.mjs plants an equivalent check atop
 * dist/standalone/server.js. `exit` is injected so this is testable.
 */
export function assertBunRuntime(exit: (code: number) => never = process.exit): void {
  if (process.versions.bun) {
    return;
  }
  console.error(BUN_REQUIRED_MESSAGE.replace("{runtime}", describeRuntime()));
  exit(1);
}
