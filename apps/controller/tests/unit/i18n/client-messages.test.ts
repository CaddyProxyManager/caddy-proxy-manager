/**
 * The browser gets the catalog minus SERVER_ONLY_MESSAGES. A client module reaching a key left out
 * renders it raw, and nothing else would notice, so every module that can run in the browser is
 * checked here: the client graph, plus anything calling the `useTranslations` hook.
 */
import { relative } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { AbstractIntlMessages } from 'next-intl';
import messages from '../../../messages/en.json';
import { listSources, readSource, root, src, walkClientGraph } from '@/tests/helpers/client-graph';
import { SERVER_ONLY_MESSAGES, clientMessages } from '@/src/lib/locale/client-messages';

const catalog = messages as unknown as AbstractIntlMessages;
const sent = clientMessages(catalog);

function at(node: AbstractIntlMessages | string | undefined, path: string): unknown {
  let current: unknown = node;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function clientModules(): string[] {
  const graph = [...walkClientGraph().keys()];
  const hooks = listSources(src).filter((file) => readSource(file).includes('useTranslations('));
  return [...new Set([...graph, ...hooks])];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a module could reach `path`: its namespace given to the hook, or the key it ends in. */
function reaches(code: string, path: string): boolean {
  const segments = path.split('.');
  const last = escapeRegExp(segments.at(-1) as string);
  const scoped = new RegExp(`useTranslations\\(\\s*["'\`]${escapeRegExp(path)}(?:["'\`.])`);
  if (scoped.test(code)) return true;
  // A key relative to a parent namespace. A top-level one is reached only by a root translator.
  if (segments.length > 1) return new RegExp(`["'\`.]${last}(?:["'\`.])`).test(code);
  return /useTranslations\(\s*\)/.test(code) && new RegExp(`\\(\\s*["'\`]${last}\\.`).test(code);
}

describe('client messages', () => {
  it('names only paths the catalog has, so the list cannot rot', () => {
    for (const path of SERVER_ONLY_MESSAGES) expect(at(catalog, path)).toBeDefined();
  });

  it('leaves out exactly the server-only paths', () => {
    for (const path of SERVER_ONLY_MESSAGES) expect(at(sent, path)).toBeUndefined();
    const count = (node: unknown): number =>
      typeof node === 'string'
        ? 1
        : Object.values(node as object).reduce((sum: number, child) => sum + count(child), 0);
    const removed = SERVER_ONLY_MESSAGES.reduce((sum, path) => sum + count(at(catalog, path)), 0);
    expect(count(sent)).toBe(count(catalog) - removed);
    // The catalog itself is untouched: server components still read all of it.
    for (const path of SERVER_ONLY_MESSAGES) expect(at(catalog, path)).toBeDefined();
  });

  it('keeps every namespace a client module asks the hook for', () => {
    const missing: string[] = [];
    for (const file of clientModules()) {
      for (const match of readSource(file).matchAll(/useTranslations\(\s*["'`]([^"'`]+)["'`]/g)) {
        if (at(sent, match[1]) === undefined) {
          missing.push(`${relative(root, file).replaceAll('\\', '/')}: ${match[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('sends nothing a client module reaches from the server-only paths', () => {
    const offenders: string[] = [];
    for (const file of clientModules()) {
      const code = readSource(file);
      for (const path of SERVER_ONLY_MESSAGES) {
        if (reaches(code, path))
          offenders.push(`${relative(root, file).replaceAll('\\', '/')}: ${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('notices a client module that would reach one', () => {
    expect(reaches('const t = useTranslations("email");', 'email')).toBe(true);
    expect(reaches('const t = useTranslations(); t("email.subject")', 'email')).toBe(true);
    expect(reaches('const t = useTranslations("settings"); t("email.title")', 'email')).toBe(false);
    expect(
      reaches('const t = useTranslations("auditLog"); t(`summaries.` + k)', 'auditLog.summaries'),
    ).toBe(true);
    expect(
      reaches('const t = useTranslations("setup.migrateErrors");', 'setup.migrateErrors'),
    ).toBe(true);
    expect(reaches('const t = useTranslations("settings.email");', 'email')).toBe(false);
  });
});
