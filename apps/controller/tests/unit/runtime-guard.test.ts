/**
 * The guard must behave correctly in the case it exists for - a runtime that is not Bun, which is
 * not the one this suite runs on. Reproduced by removing `process.versions.bun` for a test.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { assertBunRuntime } from '@/src/lib/runtime/runtime-guard';

/** Stands in for process.exit, which the real signature declares as `never`. */
const exitSpy = () => {
  const calls: number[] = [];
  const exit = vi.fn((code: number) => {
    calls.push(code);
    return undefined as never;
  });
  return { exit, calls };
};

function asNonBunRuntime(run: () => void) {
  const original = process.versions.bun;
  delete (process.versions as { bun?: string }).bun;
  try {
    run();
  } finally {
    process.versions.bun = original;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assertBunRuntime', () => {
  it('does nothing when Bun is the runtime', () => {
    const { exit, calls } = exitSpy();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    assertBunRuntime(exit);

    expect(calls).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('exits non-zero, naming the runtime and how to start it, when Bun is absent', () => {
    const { exit, calls } = exitSpy();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    asNonBunRuntime(() => assertBunRuntime(exit));

    expect(calls).toEqual([1]);
    const message = error.mock.calls[0]?.[0] as string;
    // A bare "wrong runtime" message leaves the operator guessing; the whole
    // point of failing here is to say what to run instead.
    expect(message).toContain('requires the Bun runtime');
    expect(message).toContain(`Node.js ${process.versions.node}`);
    expect(message).toContain('bun server.js');
  });
});
