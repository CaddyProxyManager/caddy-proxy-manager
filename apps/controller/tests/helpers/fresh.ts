let counter = 0;

/**
 * Bun's `vi.resetModules()`: a unique suffix re-evaluates the module. Build the specifier in the
 * test file - a dynamic import resolves relative to its writer.
 *
 * Coverage credits nothing to a copy loaded this way, so it is the last resort, for a module that
 * does its work at import (the database connection, see ./fresh-db.ts). Prefer a reset seam.
 */
export function fresh(): string {
  return `?fresh=${++counter}`;
}
