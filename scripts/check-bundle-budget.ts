/**
 * Fails when any browser chunk in `dir` gzips larger than `--max-kib`, so a regression breaks CI
 * rather than scrolling past as a build warning. Usage: bun scripts/check-bundle-budget.ts
 * <dir> --max-kib=<n>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith("--"));
const maxKib = Number(args.find((arg) => arg.startsWith("--max-kib="))?.split("=")[1]);
if (!dir || !Number.isFinite(maxKib)) {
  console.error("usage: bun scripts/check-bundle-budget.ts <dir> --max-kib=<n>");
  process.exit(2);
}

function* scripts(path: string): Generator<string> {
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) yield* scripts(full);
    else if (/\.m?js$/.test(entry)) yield full;
  }
}

const sizes = [...scripts(dir)]
  .map((file) => ({ file: relative(dir, file), kib: gzipSync(readFileSync(file)).length / 1024 }))
  .sort((a, b) => b.kib - a.kib);
if (sizes.length === 0) {
  console.error(`No scripts under ${dir}; was it built?`);
  process.exit(2);
}

for (const { file, kib } of sizes.slice(0, 5))
  console.log(`${kib.toFixed(0).padStart(5)} KiB gz  ${file}`);
const over = sizes.filter(({ kib }) => kib > maxKib);
if (over.length > 0) {
  console.error(`\n${over.length} chunk(s) over the ${maxKib} KiB gzip budget.`);
  process.exit(1);
}
console.log(`\nAll ${sizes.length} chunks within the ${maxKib} KiB gzip budget.`);
