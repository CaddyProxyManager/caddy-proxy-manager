/**
 * fast-check's run count. The default keeps a PR run short; FUZZ_RUNS=10000 is for a nightly.
 * `||`, not `??`: an unset variable arrives as "" through Compose-style `${VAR:-}`.
 */
export const FUZZ_RUNS = Number(process.env.FUZZ_RUNS || 0) || 200;

/** Grows with the run count: Bun's 5s default already trips on a loaded machine. */
export const FUZZ_TIMEOUT_MS = Math.max(30_000, FUZZ_RUNS * 20);

export const fuzz = { numRuns: FUZZ_RUNS } as const;
