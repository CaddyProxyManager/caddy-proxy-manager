/**
 * Tokenizers for Caddyfile, SecLang and Dockerfile, which Astryx's tokenizer lacks and have no
 * upstream grammar worth pulling in. Readability only: Caddy and Coraza validate on save.
 */

import { flatTokensToLines, tokenize, type TokenLine } from "@astryxdesign/core/CodeBlock";

export type CodeEditorLanguage =
  | "json"
  | "caddyfile"
  | "dockerfile"
  | "html"
  | "seclang"
  | "plaintext";

/** Names, so not translated; plain text is described in words, from the catalog in CodeEditor. */
export const LANGUAGE_LABELS: Record<Exclude<CodeEditorLanguage, "plaintext">, string> = {
  json: "JSON",
  caddyfile: "Caddyfile",
  dockerfile: "Dockerfile",
  html: "HTML",
  seclang: "SecLang",
};

/**
 * Types are Astryx's; others render unstyled. First match wins, so comments and strings go first,
 * and groups must be non-capturing since the group index identifies the rule. Line-start rules
 * match `^[ \t]*` (lookbehind throws on some engines) and are marked `indented` to skip it.
 */
type Rule = readonly [RegExp, string] | readonly [RegExp, string, "indented"];

const CADDYFILE: readonly Rule[] = [
  [/#.*/, "comment"],
  [/"(?:[^"\\]|\\.)*"/, "string"],
  [/`[^`]*`/, "string"],
  // The source of most Caddyfile confusion, so coloured apart from the strings they sit in.
  [/\{[^}\s]*\}/, "variable"],
  [/@[\w.-]+/, "type"],
  [/\b\d+(?:\.\d+)?(?:ms|s|m|h|d|kb|mb|gb)?\b/, "number"],
  [/^[ \t]*[a-z_][\w.]*/, "keyword", "indented"],
  [/[{}]/, "punctuation"],
];

const SECLANG: readonly Rule[] = [
  [/#.*/, "comment"],
  [/"(?:[^"\\]|\\.)*"/, "string"],
  [/'(?:[^'\\]|\\.)*'/, "string"],
  [/^[ \t]*Sec[A-Za-z]+/, "keyword", "indented"],
  [/@[A-Za-z]+/, "operator"],
  [/\b[A-Z][A-Z0-9_]{2,}(?::[\w.-]+)?\b/, "variable"],
  [/\b\d+\b/, "number"],
  [/[|,]/, "punctuation"],
];

const DOCKERFILE: readonly Rule[] = [
  [/#.*/, "comment"],
  [/"(?:[^"\\]|\\.)*"/, "string"],
  [
    /^[ \t]*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/,
    "keyword",
    "indented",
  ],
  [/\$\{?[A-Za-z_]\w*\}?/, "variable"],
  [/\bas\b/, "operator"],
  [/\b\d+\b/, "number"],
];

type Compiled = { pattern: RegExp; types: string[]; indented: boolean[] };

/** Case matters in two of the three: SecLang variables are screaming case, Caddyfile is lowercase. */
function compile(rules: readonly Rule[], flags: string): Compiled {
  return {
    pattern: new RegExp(rules.map(([re]) => `(${re.source})`).join("|"), flags),
    types: rules.map(([, type]) => type),
    indented: rules.map(([, , indented]) => indented === "indented"),
  };
}

const SOURCES: Partial<Record<CodeEditorLanguage, [readonly Rule[], string]>> = {
  caddyfile: [CADDYFILE, "gm"],
  seclang: [SECLANG, "gm"],
  dockerfile: [DOCKERFILE, "gmi"],
};

/**
 * Compiled on first use: a bad `RegExp` at module scope would throw uncatchably on import, taking
 * the whole editor down rather than only its colour.
 */
const cache = new Map<CodeEditorLanguage, Compiled>();

function compiledFor(language: CodeEditorLanguage): Compiled | undefined {
  const cached = cache.get(language);
  if (cached) return cached;

  const source = SOURCES[language];
  if (!source) return undefined;

  const compiled = compile(source[0], source[1]);
  cache.set(language, compiled);
  return compiled;
}

function indentLength(text: string): number {
  let length = 0;
  while (text[length] === " " || text[length] === "\t") length += 1;
  return length;
}

function scan(code: string, compiled: Compiled): { type: string; start: number; end: number }[] {
  const tokens: { type: string; start: number; end: number }[] = [];
  compiled.pattern.lastIndex = 0;

  let match = compiled.pattern.exec(code);
  while (match) {
    // Group n+1 is rule n; exactly one of them is defined on any match.
    const rule = match.findIndex((group, index) => index > 0 && group !== undefined) - 1;
    if (rule >= 0 && match[0]) {
      // The renderer slices lines by these offsets, and would otherwise paint the indent and shift
      // every following token.
      const offset = compiled.indented[rule] ? indentLength(match[0]) : 0;
      tokens.push({
        type: compiled.types[rule] as string,
        start: match.index + offset,
        end: match.index + match[0].length,
      });
    }
    // A pattern that can match nothing would otherwise spin here forever.
    if (!match[0]) compiled.pattern.lastIndex += 1;
    match = compiled.pattern.exec(code);
  }

  return tokens;
}

/**
 * Per line, line-relative offsets, as Astryx's `CodeBlock` takes them. Empty for plaintext or on
 * failure: unhighlighted text beats a field that throws.
 */
export function tokenizeCode(code: string, language: CodeEditorLanguage): TokenLine[] {
  if (language === "plaintext" || !code) return [];

  try {
    const compiled = compiledFor(language);
    return compiled ? flatTokensToLines(scan(code, compiled), code) : tokenize(code, language);
  } catch {
    return [];
  }
}
