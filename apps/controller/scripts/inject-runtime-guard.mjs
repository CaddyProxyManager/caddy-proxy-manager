/**
 * vinext gives dist/standalone/server.js a `node` shebang, which fails on `bun:sqlite` while
 * linking, before runtime/runtime-guard.ts can run - so the check is planted atop it. Re-run each build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUN_REQUIRED_MESSAGE } from "../src/lib/runtime/runtime-guard.ts";

const entry = resolve(import.meta.dirname, "..", "dist", "standalone", "server.js");
const MARKER = "// caddy-proxy-manager:runtime-guard";

const guard = `${MARKER}
// Injected by scripts/inject-runtime-guard.mjs - keep in sync with src/lib/runtime/runtime-guard.ts.
if (!process.versions.bun) {
  const runtime = process.versions.node ? \`Node.js \${process.versions.node}\` : "an unknown runtime";
  console.error(${JSON.stringify(BUN_REQUIRED_MESSAGE)}.replace("{runtime}", runtime));
  process.exit(1);
}
`;

let source;
try {
  source = readFileSync(entry, "utf8");
} catch (error) {
  console.error(`[runtime-guard] Could not read ${entry}: ${error.message}`);
  process.exit(1);
}

if (source.includes(MARKER)) {
  console.log("[runtime-guard] Already present in dist/standalone/server.js");
  process.exit(0);
}

// Before every import, with the shebang (retargeted at Bun) kept on line 1.
const lines = source.split("\n");
const hasShebang = lines[0]?.startsWith("#!");
if (!hasShebang) {
  console.error(
    "[runtime-guard] dist/standalone/server.js has no shebang - the generated entry changed shape, " +
      "so the guard was not injected. Update scripts/inject-runtime-guard.mjs.",
  );
  process.exit(1);
}

const patched = ["#!/usr/bin/env bun", guard, ...lines.slice(1)].join("\n");
writeFileSync(entry, patched);
console.log("[runtime-guard] Guarded dist/standalone/server.js against non-Bun runtimes");
