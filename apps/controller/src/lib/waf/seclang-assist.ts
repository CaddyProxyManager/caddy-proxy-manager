/**
 * What the SecLang text editor suggests at the caret and explains under the pointer. Pure: it
 * reads the directive the position sits in, never the whole file, so it stays cheap per keystroke.
 */

import {
  ACTION_VALUES,
  COMMON_REQUEST_HEADERS,
  DIRECTIVE_VALUES,
  SECLANG_ACTIONS,
  SECLANG_CTL_OPTIONS,
  SECLANG_DIRECTIVES,
  SECLANG_OPERATORS,
  SECLANG_VARIABLES,
  type SeclangTermKind,
  canonicalTerm,
} from "./seclang-reference";

/** `values` are offered without a description of their own. */
export type SeclangSlot = SeclangTermKind | "values";

type Context = {
  slot: SeclangSlot;
  /** What is typed so far of the term being completed. */
  prefix: string;
  /** For values: the words on offer. */
  values?: readonly string[];
};

export type SeclangCompletion = {
  label: string;
  /** Text replacing the prefix; may end in `:` or a space so the next part follows. */
  insert: string;
  slot: SeclangSlot;
  /** For a catalog lookup: the term's kind, when it has a description. */
  term?: SeclangTermKind;
};

export type SeclangCompletionResult = { from: number; to: number; items: SeclangCompletion[] };

const MAX_ITEMS = 60;

/** Where the directive holding `offset` starts: back over lines that end in `\`. */
function directiveStart(text: string, offset: number): number {
  let start = text.lastIndexOf("\n", offset - 1) + 1;
  while (start > 0) {
    const prevEnd = start - 1;
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1;
    if (!text.slice(prevStart, prevEnd).trimEnd().endsWith("\\")) break;
    start = prevStart;
  }
  return start;
}

/** The directive up to `offset`, continuations joined as Coraza joins them. */
function directivePrefix(text: string, offset: number): string {
  return text
    .slice(directiveStart(text, offset), offset)
    .split("\n")
    .map((line, index, all) => {
      // The caret's own line keeps its trailing space: it says the next argument has begun.
      if (index === all.length - 1) return line.trimStart();
      const trimmed = line.trim();
      return trimmed.endsWith("\\") ? trimmed.slice(0, -1) : trimmed;
    })
    .join("");
}

type Arg = { text: string; isQuoted: boolean; isOpen: boolean };

/** Splits a directive into arguments: `"..."` with `\"` escapes, or bare words. */
function splitArgs(line: string): { args: Arg[]; endsInSpace: boolean } {
  const args: Arg[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length && !(line[j] === '"' && line[j - 1] !== "\\")) j++;
      const isOpen = j >= line.length;
      args.push({ text: line.slice(i + 1, isOpen ? j : j), isQuoted: true, isOpen });
      i = j + 1;
    } else {
      let j = i;
      while (j < line.length && !/\s/.test(line[j])) j++;
      args.push({ text: line.slice(i, j), isQuoted: false, isOpen: j >= line.length });
      i = j;
    }
  }
  return { args, endsInSpace: /\s$/.test(line) };
}

function actionsContext(list: string): Context | null {
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i - 1] === "\\") continue;
    if (list[i] === "'") inQuote = !inQuote;
    else if (list[i] === "," && !inQuote) start = i + 1;
  }
  if (inQuote) return null;
  const current = list.slice(start).trimStart();
  const colon = current.indexOf(":");
  if (colon === -1)
    return /^[A-Za-z]*$/.test(current) ? { slot: "actions", prefix: current } : null;
  const name = current.slice(0, colon).toLowerCase();
  const value = current.slice(colon + 1);
  if (name === "t") return { slot: "transformations", prefix: value };
  if (name === "ctl") {
    if (value.includes("=")) return null;
    return { slot: "values", prefix: value, values: SECLANG_CTL_OPTIONS.map((o) => `${o}=`) };
  }
  if (name === "setvar" && value === "") return { slot: "values", prefix: "", values: ["tx."] };
  const values = ACTION_VALUES[name];
  return values ? { slot: "values", prefix: value, values } : null;
}

function variablesContext(arg: string): Context | null {
  const current = arg.slice(arg.lastIndexOf("|") + 1).replace(/^[!&]+/, "");
  const colon = current.indexOf(":");
  if (colon === -1) return { slot: "variables", prefix: current };
  const collection = current.slice(0, colon).toUpperCase();
  if (collection === "REQUEST_HEADERS" || collection === "REQUEST_HEADERS_NAMES") {
    return { slot: "values", prefix: current.slice(colon + 1), values: COMMON_REQUEST_HEADERS };
  }
  return null;
}

/** What is being typed at the end of `line`, a directive's text so far. */
function contextOf(line: string): Context | null {
  if (line.startsWith("#")) return null;
  const { args, endsInSpace } = splitArgs(line);
  const last = args[args.length - 1];
  // Past a closed argument and a space, the next one starts empty.
  const typing = !last || (endsInSpace && !(last.isQuoted && last.isOpen)) ? null : last;
  const index = typing ? args.length - 1 : args.length;
  const text = typing?.text ?? "";

  if (index === 0) return { slot: "directives", prefix: text };
  const directive = args[0].text.toLowerCase();

  if (directive === "secrule") {
    if (index === 1) return typing?.isQuoted ? null : variablesContext(text);
    if (index === 2) {
      if (!typing) return null;
      const op = /^!?@([A-Za-z0-9]*)$/.exec(text);
      return op ? { slot: "operators", prefix: op[1] } : null;
    }
    if (index === 3 && typing?.isQuoted && typing.isOpen) return actionsContext(text);
    return null;
  }

  if (directive === "secaction" || directive === "secdefaultaction") {
    if (index === 1 && typing?.isQuoted && typing.isOpen) return actionsContext(text);
    return null;
  }

  const values = DIRECTIVE_VALUES[directive];
  if (values && index === 1 && !typing?.isQuoted) return { slot: "values", prefix: text, values };
  return null;
}

function candidates(context: Context): { label: string; insert: string }[] {
  switch (context.slot) {
    case "directives":
      return SECLANG_DIRECTIVES.map((d) => ({ label: d, insert: `${d} ` }));
    case "variables":
      return SECLANG_VARIABLES.map((v) => ({ label: v, insert: v }));
    case "operators":
      return SECLANG_OPERATORS.map((o) => ({ label: o, insert: `${o} ` }));
    case "actions":
      return SECLANG_ACTIONS.map((a) => ({
        label: a.name,
        insert: a.argument === "none" ? a.name : `${a.name}:`,
      }));
    case "transformations":
      return (ACTION_VALUES.t ?? []).map((t) => ({ label: t, insert: t }));
    case "values":
      return (context.values ?? []).map((v) => ({ label: v, insert: v }));
  }
}

/** Prefix matches first, then matches anywhere; case-insensitive. */
function rank<T extends { label: string }>(items: readonly T[], prefix: string): T[] {
  const lower = prefix.toLowerCase();
  if (!lower) return [...items];
  const starts = items.filter((item) => item.label.toLowerCase().startsWith(lower));
  const contains = items.filter(
    (item) =>
      !item.label.toLowerCase().startsWith(lower) && item.label.toLowerCase().includes(lower),
  );
  return [...starts, ...contains];
}

/** Suggestions for the caret, or null where nothing fits. An exact lone match is no suggestion. */
export function seclangCompletions(text: string, caret: number): SeclangCompletionResult | null {
  const context = contextOf(directivePrefix(text, caret));
  if (!context) return null;
  const items = rank(candidates(context), context.prefix)
    .slice(0, MAX_ITEMS)
    .map((item) => ({
      ...item,
      slot: context.slot,
      term: context.slot === "values" ? undefined : context.slot,
    }));
  if (items.length === 0) return null;
  if (items.length === 1 && items[0].insert.trim() === context.prefix) return null;
  return { from: caret - context.prefix.length, to: caret, items };
}

export type SeclangTerm = { kind: SeclangTermKind; name: string; from: number; to: number };

const WORD = /[A-Za-z0-9_]/;

/** The SecLang term at `offset`, for a hover: its kind and canonical name. */
export function seclangTermAt(text: string, offset: number): SeclangTerm | null {
  if (offset < 0 || offset > text.length) return null;
  let from = offset;
  let to = offset;
  while (from > 0 && WORD.test(text[from - 1])) from--;
  while (to < text.length && WORD.test(text[to])) to++;
  if (from === to) return null;
  const context = contextOf(directivePrefix(text, to));
  if (!context || context.slot === "values") return null;
  const word = text.slice(from, to);
  // The word must be the whole term, not a fragment such as the `ARGS` of `ARGS_NAMES`.
  if (context.prefix.toLowerCase() !== word.toLowerCase()) return null;
  const name = canonicalTerm(context.slot, word);
  return name ? { kind: context.slot, name, from, to } : null;
}
