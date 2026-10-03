import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

// A `node:` import reached from a "use client" module breaks the browser bundle, and only in
// vinext dev ("externalized for browser compatibility") - the production build and every bun
// test still pass. So walk the graph statically instead.

const root = process.cwd();
const src = join(root, 'src');
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const extensions = ['.ts', '.tsx', '.js', '.mjs', '.json'];

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

function directive(code: string): string | null {
  const match = code.match(
    /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*(['"])(use (?:client|server))\1/,
  );
  return match?.[2] ?? null;
}

function resolveFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of extensions) if (existsSync(base + ext)) return base + ext;
  for (const ext of extensions) {
    const index = join(base, `index${ext}`);
    if (existsSync(index)) return index;
  }
  return null;
}

// Mirrors the tsconfig paths.
function resolveSpecifier(from: string, spec: string): string | null {
  if (spec.startsWith('.')) return resolveFile(resolve(dirname(from), spec));
  if (spec.startsWith('@/components/')) return resolveFile(join(src, 'components', spec.slice(13)));
  if (spec.startsWith('@/lib/')) return resolveFile(join(src, 'lib', spec.slice(6)));
  if (spec.startsWith('@/src/')) return resolveFile(join(src, spec.slice(6)));
  if (spec.startsWith('@/')) {
    return resolveFile(join(root, spec.slice(2))) ?? resolveFile(join(src, spec.slice(2)));
  }
  return null;
}

// Runtime imports only: `import type` and all-`type` specifier lists are erased by the bundler.
function runtimeImports(code: string): string[] {
  const specs: string[] = [];
  const statement =
    /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(statement)) {
    if (m[5]) specs.push(m[5]);
    else if (m[6]) specs.push(m[6]);
    else if (m[4] && !m[2]) {
      const clause = m[3];
      const named = clause.match(/^\{([\s\S]*)\}$/);
      if (named) {
        const parts = named[1]
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length > 0 && parts.every((p) => p.startsWith('type '))) continue;
      }
      specs.push(m[4]);
    }
  }
  return specs;
}

function findNodeImportsFromClient(): string[] {
  const code = new Map<string, string>();
  const read = (file: string) => {
    let text = code.get(file);
    if (text === undefined) {
      text = readFileSync(file, 'utf8');
      code.set(file, text);
    }
    return text;
  };
  const entries = listSources(src).filter((file) => directive(read(file)) === 'use client');
  const parent = new Map<string, string | null>(entries.map((e) => [e, null]));
  const queue = [...entries];
  const hits: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const spec of runtimeImports(read(file))) {
      if (builtins.has(spec)) {
        const chain: string[] = [spec];
        for (let at: string | null = file; at; at = parent.get(at) ?? null) {
          chain.unshift(relative(root, at).replaceAll('\\', '/'));
        }
        hits.push(chain.join(' -> '));
        continue;
      }
      const target = resolveSpecifier(file, spec);
      if (!target || !/\.(ts|tsx)$/.test(target) || parent.has(target)) continue;
      // A server action module reaches the client as a reference, not its code.
      if (directive(read(target)) === 'use server') continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
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
