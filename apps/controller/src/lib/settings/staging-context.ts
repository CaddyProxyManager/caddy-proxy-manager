/**
 * The scope that turns a settings read or write into a staged one. Threading "pretend" values
 * through two dozen helpers and the config builder would touch every link; AsyncLocalStorage
 * needs only `getSetting` and `setSetting`. Values stay serialized JSON, so staged reads parse
 * identically.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type StagingScope = {
  /** Wins over the table. A staged clear is `"null"`: present, so it wins, and parses to null. */
  overlay: ReadonlyMap<string, string>;
  /** `setSetting` writes here instead; absent, writes land for real (apply, dry-run render). */
  capture?: Map<string, string>;
  /** Suppresses `applyCaddyConfig` while staging; the apply step pushes once for all of them. */
  suppressApply?: boolean;
};

const storage = new AsyncLocalStorage<StagingScope>();

export function currentStagingScope(): StagingScope | undefined {
  return storage.getStore();
}

export function withStagingScope<T>(scope: StagingScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/**
 * For cache writes such as an update check's result: triggered by a read, they inherit its scope,
 * and a cache in an operator's change set would be baffling to review and wrong to apply.
 */
export function outsideStagingScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.exit(fn);
}

/** How the config builder renders what Caddy *would* receive. Writes still land. */
export function withStagedReads<T>(
  overlay: ReadonlyMap<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  return withStagingScope({ overlay }, fn);
}

/**
 * Reads are overlaid too, so a read-edit-write of a blob composes with earlier staged edits rather
 * than reverting them.
 */
export async function withCapturedWrites<T>(
  overlay: ReadonlyMap<string, string>,
  fn: () => Promise<T>,
): Promise<{ result: T; writes: Map<string, string> }> {
  const capture = new Map<string, string>();
  const result = await withStagingScope({ overlay, capture, suppressApply: true }, fn);
  return { result, writes: capture };
}
