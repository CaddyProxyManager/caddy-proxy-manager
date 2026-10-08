import { builtinModules } from 'node:module';
import { relative } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { root, runtimeImports, walkClientGraph } from '@/tests/helpers/client-graph';

// A `node:` import reached from a "use client" module breaks the browser bundle, and only in
// vite dev ("externalized for browser compatibility") - the production build and every bun
// test still pass. So walk the graph statically instead.

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function findNodeImportsFromClient(): string[] {
  const hits: string[] = [];
  walkClientGraph((file, spec, parent) => {
    if (!builtins.has(spec)) return false;
    const chain: string[] = [spec];
    for (let at: string | null = file; at; at = parent.get(at) ?? null) {
      chain.unshift(relative(root, at).replaceAll('\\', '/'));
    }
    hits.push(chain.join(' -> '));
    return true;
  });
  return hits;
}

describe('client bundle boundary', () => {
  it('reaches no node: builtin from a "use client" module', () => {
    expect(findNodeImportsFromClient()).toEqual([]);
  });

  it('parses the import shapes the walker relies on', () => {
    expect(
      runtimeImports(
        [
          'import { isIP } from "node:net";',
          'import type { X } from "./x";',
          'import { type Y, type Z } from "./yz";',
          'import { type A, b } from "./ab";',
          'export { c } from "./c";',
          'import "./side-effect";',
          'const d = await import("./lazy");',
        ].join('\n'),
      ),
    ).toEqual(['node:net', './ab', './c', './side-effect', './lazy']);
  });
});
