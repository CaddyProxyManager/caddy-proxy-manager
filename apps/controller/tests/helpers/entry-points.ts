/**
 * Finds every server action and REST handler and the body each one runs, by scanning source text.
 * No TypeScript dependency: the controller does not declare one, and the isolated linker hides it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SRC_ROOT = join(import.meta.dir, '../../src');
const APP_ROOT = join(SRC_ROOT, 'app');
const API_ROOT = join(APP_ROOT, 'api');

export type EntryPoint = {
  /** `app/(dashboard)/users/actions.ts#deleteUserAction` or `GET /api/v1/users`. */
  id: string;
  file: string;
  /** The exported function's own body, plus the bodies of same-file functions it calls. */
  body: string;
  /** The exported function's body alone. */
  ownBody: string;
};

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

/** Index of the closing backtick of the template literal opening at `open`. */
function skipTemplate(source: string, open: number): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === '`') return i;
    else if (source[i] === '$' && source[i + 1] === '{') i = matchBrace(source, i + 1) - 1;
  }
  return source.length;
}

/** Index just past the brace matching the one at `open`, skipping strings and comments. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return source.length;
    } else if (c === '/' && next === '*') {
      i = source.indexOf('*/', i + 2) + 1;
    } else if (c === '"' || c === "'") {
      for (i++; i < source.length && source[i] !== c && source[i] !== '\n'; i++) {
        if (source[i] === '\\') i++;
      }
    } else if (c === '`') {
      i = skipTemplate(source, i);
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * From just inside a parameter list to its body's brace, past a return type that may itself hold
 * braces (`Promise<{ ok: true }>`, `: { code: string } {`).
 */
function bodyAfterParameters(source: string, start: number): number {
  let parens = 1;
  let angles = 0;
  let previous = '';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (parens > 0) {
      if (c === '{') i = matchBrace(source, i) - 1;
    } else if (c === '<') angles++;
    else if (c === '>' && source[i - 1] !== '=') angles--;
    else if (c === '{') {
      if (angles === 0 && previous !== ':' && previous !== '|' && previous !== '&') return i;
      i = matchBrace(source, i) - 1;
    }
    if (!/\s/.test(c)) previous = source[i];
  }
  return source.length;
}

/** Every named function in the file, declared or assigned, with its body. */
export function localFunctions(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const patterns = [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g,
    /(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[0].length;
      const i = pattern === patterns[0] ? bodyAfterParameters(source, start) : start;
      const open = source.slice(i).search(/\S/) + i;
      if (source[open] !== '{') continue;
      found.set(match[1], source.slice(open, matchBrace(source, open)));
    }
  }
  return found;
}

/** A body together with the same-file functions it reaches, so a shared guard helper counts. */
function withLocalCallees(body: string, functions: Map<string, string>): string {
  const seen = new Set<string>();
  const parts = [body];
  for (let index = 0; index < parts.length; index++) {
    for (const [name, inner] of functions) {
      if (seen.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(parts[index])) {
        seen.add(name);
        parts.push(inner);
      }
    }
  }
  return parts.join('\n');
}

const label = (file: string) => relative(SRC_ROOT, file).split(sep).join('/');

export function serverActions(): EntryPoint[] {
  const files = walk(APP_ROOT, (path) => /\.tsx?$/.test(path)).filter((file) =>
    /^\s*["']use server["']/.test(readFileSync(file, 'utf8')),
  );
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const functions = localFunctions(source);
    const exported = [...source.matchAll(/\nexport\s+(?:async\s+function|const)\s+(\w+)/g)].map(
      (match) => match[1],
    );
    return exported.map((name) => {
      let body = functions.get(name);
      if (body === undefined) {
        // `export const x = wrapper(inner)`: the wrapper and what it wraps both run.
        const assignment = source.match(new RegExp(`export const ${name} = ([^;]+);`));
        body = assignment?.[1] ?? '';
      }
      return {
        id: `${label(file)}#${name}`,
        file,
        body: withLocalCallees(body, functions),
        ownBody: body,
      };
    });
  });
}

export function restHandlers(): EntryPoint[] {
  return walk(API_ROOT, (path) => path.endsWith(`${sep}route.ts`)).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const functions = localFunctions(source);
    const segments = relative(API_ROOT, file).split(sep).slice(0, -1);
    const path = `/api/${segments.join('/')}`;
    const methods = [
      ...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g),
    ].map((match) => match[1]);
    const reexported = [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)];
    const entries = methods.map((method) => ({
      id: `${method} ${path}`,
      file,
      body: withLocalCallees(functions.get(method) ?? '', functions),
      ownBody: functions.get(method) ?? '',
    }));
    for (const match of reexported) {
      const assignment = source.slice(match.index).split(';')[0];
      entries.push({
        id: `${match[1]} ${path}`,
        file,
        body: withLocalCallees(assignment, functions),
        ownBody: assignment,
      });
    }
    return entries;
  });
}
