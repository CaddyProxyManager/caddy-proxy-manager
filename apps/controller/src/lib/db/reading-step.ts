/**
 * A statement for runInTransaction that reads before it writes. One generator drives both
 * dialects: bun:sqlite's `.all()`/`.run()` synchronously, PostgreSQL's builders awaited.
 */

/** `all` returns rows; `run` is a write. */
export type Step = { all: unknown } | { run: unknown };

// biome-ignore lint/suspicious/noExplicitAny: builder types are per-dialect
type Builder = any;

export function readingStep(
  body: () => Generator<Step, void, unknown[]>,
): PromiseLike<void> & { run: () => void } {
  return {
    run() {
      const steps = body();
      let next = steps.next([]);
      while (!next.done) {
        const step = next.value;
        if ("all" in step) {
          next = steps.next((step.all as Builder).all());
        } else {
          (step.run as Builder).run();
          next = steps.next([]);
        }
      }
    },
    // biome-ignore lint/suspicious/noThenProperty: runInTransaction awaits PostgreSQL statements
    then(onFulfilled, onRejected) {
      return (async () => {
        const steps = body();
        let next = steps.next([]);
        while (!next.done) {
          const step = next.value;
          const result = await ("all" in step ? step.all : step.run);
          next = steps.next(Array.isArray(result) ? result : []);
        }
      })().then(onFulfilled, onRejected);
    },
  };
}
