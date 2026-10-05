/**
 * The client module graph, walked statically: every "use client" module and what it imports at
 * runtime. A server action module reaches the client as a reference, so the walk stops there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const root = process.cwd();
export const src = join(root, 'src');
const extensions = ['.ts', '.tsx', '.js', '.mjs', '.json'];

export function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** A loop, not one regex: skipping the leading comments that way can backtrack exponentially. */
export function directive(code: string): string | null {
  let rest = code;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n');
      rest = end === -1 ? '' : rest.slice(end + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end === -1) return null;
      rest = rest.slice(end + 2);
    } else {
      break;
    }
  }
  return rest.match(/^(['"])(use (?:client|server))\1/)?.[2] ?? null;
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
export function resolveSpecifier(from: string, spec: string): string | null {
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
export function runtimeImports(code: string): string[] {
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

const code = new Map<string, string>();

export function readSource(file: string): string {
  let text = code.get(file);
  if (text === undefined) {
    text = readFileSync(file, 'utf8');
    code.set(file, text);
  }
  return text;
}

/**
 * Breadth first from every "use client" module. `visit` sees each import specifier; returning true
 * stops the walk there. The map holds each module's importer, null for an entry.
 */
export function walkClientGraph(
  visit: (file: string, spec: string, parent: Map<string, string | null>) => boolean = () => false,
): Map<string, string | null> {
  const entries = listSources(src).filter((file) => directive(readSource(file)) === 'use client');
  const parent = new Map<string, string | null>(entries.map((e) => [e, null]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const spec of runtimeImports(readSource(file))) {
      if (visit(file, spec, parent)) continue;
      const target = resolveSpecifier(file, spec);
      if (!target || !/\.(ts|tsx)$/.test(target) || parent.has(target)) continue;
      if (directive(readSource(target)) === 'use server') continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return parent;
}
