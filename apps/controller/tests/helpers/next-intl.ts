/**
 * `getTranslations` throws without a request scope. Mocked with the real English catalog, not an
 * identity function, so a test still fails if its expected message is renamed or deleted.
 */
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';

// The real formatter, so an ICU plural or select in the catalog renders as it does for a reader.
const english = createTranslator({ locale: 'en', messages });

function lookup(key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[part];
  }, messages);
  if (typeof value !== 'string') throw new Error(`missing message: ${key}`);
  return value;
}

/** Mirrors `getTranslations(namespace?)`: keys resolve relative to the namespace when given. */
export function testTranslator(namespace?: string) {
  const t = (key: string, values: Record<string, unknown> = {}) => {
    const full = namespace ? `${namespace}.${key}` : key;
    // Checked here: the formatter would log and hand the key back rather than throw.
    lookup(full);
    return (english as unknown as (k: string, v?: Record<string, unknown>) => string)(full, values);
  };
  return Object.assign(t, {
    rich: t,
    markup: t,
    raw: (key: string) => lookup(namespace ? `${namespace}.${key}` : key),
    has: (key: string) => {
      try {
        lookup(namespace ? `${namespace}.${key}` : key);
        return true;
      } catch {
        return false;
      }
    },
  });
}

export function nextIntlServerMock() {
  return {
    getTranslations: async (namespace?: string) => testTranslator(namespace),
    getLocale: async () => 'en',
    getMessages: async () => messages,
    getFormatter: async () => ({
      list: (value: Iterable<string>, options?: Intl.ListFormatOptions) =>
        new Intl.ListFormat('en', options).format(value),
    }),
    getNow: async () => new Date(),
    getTimeZone: async () => 'UTC',
  };
}
