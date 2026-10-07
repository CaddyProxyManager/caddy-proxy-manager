/**
 * Whether a server action can let an error escape to the client, judged from its source text.
 * In a production build the client receives a thrown error without its message, so an action
 * reports failure by returning it; see `src/lib/errors/run-action.ts`.
 */

/**
 * Comments and string contents blanked, so a brace or `throw` inside either counts for nothing.
 * Same length as `source`, so an index found here points at the same place there.
 */
export function stripCommentsAndStrings(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j++) if (out[j] !== '\n') out[j] = ' ';
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop - 1;
    } else if (c === '/' && next === '*') {
      const stop = source.indexOf('*/', i + 2) + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (c === '"' || c === "'" || c === '`') {
      const start = i + 1;
      for (i++; i < source.length && source[i] !== c; i++) {
        if (source[i] === '\\') i++;
      }
      blank(start, i);
    }
  }
  return out.join('');
}

/** Index just past the brace matching the one at `open`; `source` must be stripped. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return i + 1;
  }
  return source.length;
}

/**
 * Null when the body cannot throw past itself: it is one `return runAction(...)`, or one
 * `try` whose `catch` returns rather than throws. Otherwise, why not.
 */
export function escapingThrow(body: string): string | null {
  const code = stripCommentsAndStrings(body).trim();
  // `void _prevState;` cannot throw, and keeps an unused useActionState parameter lint-clean.
  const inner = code
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .trim()
    .replace(/^(?:void\s+\w+\s*;\s*)+/, '');
  if (/^return\s+(?:await\s+)?runAction\(/.test(inner) && /\)\s*;?$/.test(inner)) {
    // Nothing may follow the call: a second statement would run outside it.
    let depth = 0;
    const open = inner.indexOf('(');
    for (let i = open; i < inner.length; i++) {
      if (inner[i] === '(') depth++;
      else if (inner[i] === ')' && --depth === 0) {
        return /^\s*;?$/.test(inner.slice(i + 1)) ? null : 'code after runAction()';
      }
    }
  }
  if (inner.startsWith('try')) {
    const tryOpen = inner.indexOf('{');
    const tryEnd = matchBrace(inner, tryOpen);
    const rest = inner.slice(tryEnd).trim();
    const catchMatch = rest.match(/^catch\s*(?:\([^)]*\))?\s*/);
    if (!catchMatch) return 'try without catch';
    const catchOpen = catchMatch[0].length;
    const catchEnd = matchBrace(rest, catchOpen);
    const handler = rest.slice(catchOpen, catchEnd);
    const after = rest.slice(catchEnd).trim();
    if (after !== '') return 'code after the try';
    if (/\bthrow\b/.test(handler)) return 'the catch throws';
    // Otherwise an expired session's redirect to /login is reported as an error instead.
    if (!/^\{\s*unstable_rethrow\(\w+\);/.test(handler)) {
      return 'the catch does not start with unstable_rethrow()';
    }
    return null;
  }
  return 'not wrapped in runAction() or a try that returns';
}

/**
 * For `export const x = wrapper(inner)`: the wrapper's returned function is what runs, so that
 * is what gets judged. `functions` is the file's own, from `localFunctions`.
 */
export function wrapperEscapes(assignment: string, functions: Map<string, string>): string | null {
  const name = assignment.trim().match(/^(\w+)\(/)?.[1];
  const wrapper = name ? functions.get(name) : undefined;
  if (!wrapper) return 'not wrapped in runAction() or a try that returns';
  const code = stripCommentsAndStrings(wrapper);
  const arrow = code.match(/return\s+async\s*\([^)]*\)\s*(?::[^=]+)?=>\s*/);
  if (!arrow || arrow.index === undefined) return `${name} does not return an async function`;
  const start = arrow.index + arrow[0].length;
  if (code[start] !== '{') {
    return /^runAction\(/.test(code.slice(start)) ? null : `${name} is not wrapped`;
  }
  const end = matchBrace(code, start);
  const verdict = escapingThrow(code.slice(start, end));
  return verdict && `${name}: ${verdict}`;
}
