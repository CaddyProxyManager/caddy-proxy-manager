import { type Mock, vi as bunVi } from 'bun:test';

/**
 * Bun's `vi` plus what it lacks (`mocked`, `hoisted`, `stubEnv`...). No `resetModules` or `doMock`:
 * Bun cannot drop a module from the registry, so a no-op would test against a cached one.
 */

const stubbedEnv = new Map<string, string | undefined>();

function mocked<T extends (...args: never[]) => unknown>(item: T): Mock<T>;
function mocked<T>(item: T): T;
/** A cast only: Bun replaces live bindings in place, so the value already is the mock. */
function mocked(item: unknown): unknown {
  return item;
}

/** Bun does not hoist `vi.mock`, so declare this above the `vi.mock` that uses it. */
function hoisted<T>(factory: () => T): T {
  return factory();
}

/** `undefined` unsets the variable, matching Vitest. */
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

/** Vitest's `vi.waitFor`, which Bun lacks; a fixed sleep would be flaky or slow. */
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
