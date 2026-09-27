import { type Mock, vi as bunVi } from "bun:test";

/**
 * Vitest's `vi` over `bun:test`, adding what Bun lacks. `resetModules` and `doMock` are absent on
 * purpose: Bun cannot drop a cached module, so a no-op would test against a stale one.
 */

/** Prior values of env vars stubbed since the last unstubAllEnvs(). */
const stubbedEnv = new Map<string, string | undefined>();

function mocked<T extends (...args: never[]) => unknown>(item: T): Mock<T>;
function mocked<T>(item: T): T;
/** A type cast only: Bun replaces live bindings, so the value already *is* the mock. */
function mocked(item: unknown): unknown {
  return item;
}

/** Runs at once: Bun does not hoist `vi.mock`, so declare this above the one that uses it. */
function hoisted<T>(factory: () => T): T {
  return factory();
}

/** `undefined` unsets, matching Vitest. */
function stubEnv(name: string, value: string | undefined): void {
  if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function unstubAllEnvs(): void {
  for (const [name, previous] of stubbedEnv) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  stubbedEnv.clear();
}

/** Vitest's `vi.waitFor`; a fixed sleep would be flaky or slow. */
async function waitFor<T>(
  check: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const { timeout = 1000, interval = 10 } = options;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export const vi = {
  ...bunVi,
  mocked,
  hoisted,
  stubEnv,
  unstubAllEnvs,
  waitFor,
};
