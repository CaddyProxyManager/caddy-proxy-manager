#!/usr/bin/env bun
/**
 * Bun's `coverageThreshold` is per file and its reporter averages per-file percentages; lcov
 * carries raw hit/found counts, so these numbers are weighted by size.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Just under today's numbers: raise as coverage improves, never lower to pass a build. They assume
 * the serial `bun run test:coverage`; under `--parallel` both sides of the ratio move.
 */
const THRESHOLDS = {
  lines: 76,
  functions: 81,
} as const;

const LCOV_PATH = resolve(import.meta.dir, "..", "coverage", "lcov.info");

type Totals = { found: number; hit: number };

/** Sums the `<prefix>F:`/`<prefix>H:` records lcov emits once per source file. */
function total(report: string, prefix: "L" | "FN"): Totals {
  let found = 0;
  let hit = 0;
  for (const line of report.split("\n")) {
    const [key, value] = line.split(":");
    if (key === `${prefix}F`) found += Number(value);
    else if (key === `${prefix}H`) hit += Number(value);
  }
  return { found, hit };
}

const percent = ({ found, hit }: Totals) => (found === 0 ? 100 : (hit / found) * 100);

let report: string;
try {
  report = readFileSync(LCOV_PATH, "utf8");
} catch {
  console.error(
    `No coverage report at ${LCOV_PATH}. Run \`bun run test:coverage\`, which produces it.`,
  );
  process.exit(1);
}

const measured = {
  lines: total(report, "L"),
  functions: total(report, "FN"),
};

let failed = false;
for (const [metric, threshold] of Object.entries(THRESHOLDS) as [
  keyof typeof THRESHOLDS,
  number,
][]) {
  const { found, hit } = measured[metric];
  const actual = percent(measured[metric]);
  const ok = actual >= threshold;
  if (!ok) failed = true;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${metric.padEnd(9)} ${actual.toFixed(2)}% (${hit}/${found}), ratchet ${threshold}%`,
  );
}

if (failed) {
  console.error(
    "\nCoverage fell below the ratchet. Add tests for what you changed rather than lowering it.",
  );
  process.exit(1);
}
