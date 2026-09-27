let counter = 0;

/**
 * Bun's `vi.resetModules()`: a unique suffix re-evaluates the module. Build the specifier in the
 * test file - a dynamic import resolves relative to its writer.
 *
 *     const { config } = await import(`../../src/lib/config${fresh()}`);
 */
export function fresh(): string {
  return `?fresh=${++counter}`;
}
