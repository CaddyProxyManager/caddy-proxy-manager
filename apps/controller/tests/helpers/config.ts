import { vi } from './vi';

/**
 * config.ts reads the environment once, at import. Reads it again and repoints the plain specifier,
 * so every importer sees the environment as the test has stubbed it.
 */
export async function reloadConfig(): Promise<
  ReturnType<typeof import('@/src/lib/config').readConfig>
> {
  const actual = await import('@/src/lib/config');
  const reread = actual.readConfig();
  vi.mock('@/src/lib/config', () => ({ ...actual, ...reread }));
  return reread;
}
