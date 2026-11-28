/**
 * SecLang as blocks a form can edit: a rule with its chain, an action, a comment, a directive.
 * Each keeps the source it came from and is re-emitted only once edited, so reordering or
 * touching one rule never reformats the rest. What the model cannot hold stays `raw` text.
 */

import { goTrimSpace, parseActions, seclangDirectives, splitRuleDirective } from "./seclang";

export type SeclangVariable = {
  name: string;
  /** After the `:`, as written: a name, `/regex/` or `'quoted'`. */
  key: string;
  /** `!`: exclude this key from the collection. */
  isExcluded: boolean;
  /** `&`: the number of matching values rather than the values. */
  isCount: boolean;
};

export type SeclangOperator = { isNegated: boolean; name: string; argument: string };

export type SeclangAction = { name: string; value: string };

/** One SecRule; a chain is several, the `chain` action implied between them. */
export type SeclangCondition = {
  variables: SeclangVariable[];
  operator: SeclangOperator;
  actions: SeclangAction[];
};

export type SeclangBlock =
  | { kind: "rule"; conditions: SeclangCondition[] }
  | { kind: "action"; actions: SeclangAction[] }
  | { kind: "defaultAction"; actions: SeclangAction[] }
  | { kind: "comment"; text: string }
  | { kind: "directive"; name: string; argument: string }
  | { kind: "raw"; text: string };

export type SeclangEntry = {
  block: SeclangBlock;
  /** Exactly what produced the block, without the blank lines before it. */
  source: string;
  /** Blank lines before the block, kept with it when it moves. */
  gapBefore: number;
};

function parseVariables(vars: string): SeclangVariable[] | null {
  const parts: string[] = [];
  let current = "";
  let state: "name" | "key" | "regex" | "quoted" = "name";
  for (let i = 0; i < vars.length; i++) {
    const c = vars[i];
    if (state === "regex") {
      current += c;
      if (c === "/" && vars[i - 1] !== "\\") state = "key";
      continue;
    }
    if (state === "quoted") {
      current += c;
      if (c === "'") state = "key";
      continue;
    }
    if (c === "|") {
      parts.push(current);
      current = "";
      state = "name";
      continue;
    }
    if (state === "name" && c === ":") state = "key";
    else if (state === "key" && vars[i - 1] === ":" && c === "/") state = "regex";
    else if (state === "key" && vars[i - 1] === ":" && c === "'") state = "quoted";
    current += c;
  }
  parts.push(current);

  const out: SeclangVariable[] = [];
  for (const part of parts) {
    const match = /^([!&]*)([A-Za-z_][A-Za-z0-9_]*)(?::([\s\S]*))?$/.exec(part);
    if (!match) return null;
    out.push({
      name: match[2].toUpperCase(),
      key: match[3] ?? "",
      isExcluded: match[1].includes("!"),
      isCount: match[1].includes("&"),
    });
  }
  return out;
}

export function parseOperator(raw: string): SeclangOperator {
  let rest = raw;
  const isNegated = rest.startsWith("!");
  if (isNegated) rest = rest.slice(1);
  if (!rest.startsWith("@")) return { isNegated, name: "rx", argument: rest };
  const space = rest.indexOf(" ");
  return space === -1
    ? { isNegated, name: rest.slice(1), argument: "" }
    : { isNegated, name: rest.slice(1, space), argument: rest.slice(space + 1).trim() };
}

function parseActionList(raw: string): SeclangAction[] {
  if (goTrimSpace(raw) === "") return [];
  return parseActions(raw).actions.map(({ name, value }) => ({
    name,
    value: value.replace(/\\'/g, "'"),
  }));
}

/** SecRule parts as Coraza cuts them, or null where it would refuse the line. */
function parseCondition(text: string): SeclangCondition | null {
  const split = splitRuleDirective(text);
  if (!split || split.operator === null) return null;
  const afterDirective = text.slice(text.indexOf(" ") + 1).trimStart();
  const vars = afterDirective.slice(0, afterDirective.search(/\s|$/));
  const variables = parseVariables(vars);
  if (!variables) return null;
  return {
    variables,
    operator: parseOperator(split.operator),
    actions: parseActionList(split.actions),
  };
}

const isChainAction = (action: SeclangAction) => action.name.toLowerCase() === "chain";

function directiveName(text: string): string {
  const space = text.search(/\s/);
  return space === -1 ? text : text.slice(0, space);
}

/** The text as blocks. `serializeSeclang` of the result gives `raw` back, byte for byte. */
export function parseSeclang(raw: string): SeclangEntry[] {
  const text = raw.replace(/\r\n?/g, "\n");
  if (text === "") return [];
  const directives = seclangDirectives(text);
  const entries: SeclangEntry[] = [];
  let gap = 0;
  let i = 0;

  const push = (block: SeclangBlock, lines: string[]) => {
    entries.push({ block, source: lines.join("\n"), gapBefore: gap });
    gap = 0;
  };

  while (i < directives.length) {
    const directive = directives[i];
    const first = goTrimSpace(directive.lines[0] ?? "");

    if (directive.text === "" && first === "") {
      gap += 1;
      i += 1;
      continue;
    }

    if (directive.text === "") {
      // Adjacent comment lines read as one note.
      const lines: string[] = [];
      while (
        i < directives.length &&
        directives[i].text === "" &&
        goTrimSpace(directives[i].lines[0]).startsWith("#")
      ) {
        lines.push(directives[i].lines[0]);
        i += 1;
      }
      const note = lines.map((line) => goTrimSpace(line).replace(/^#\s?/, "")).join("\n");
      push({ kind: "comment", text: note }, lines);
      continue;
    }

    if (directive.text === null) {
      push({ kind: "raw", text: directive.lines.join("\n") }, directive.lines);
      i += 1;
      continue;
    }

    const name = directiveName(directive.text);
    const lower = name.toLowerCase();

    if (lower === "secrule") {
      const lines = [...directive.lines];
      const conditions: SeclangCondition[] = [];
      let condition = parseCondition(directive.text);
      let isRaw = condition === null;
      i += 1;
      while (condition) {
        conditions.push(condition);
        if (!condition.actions.some(isChainAction)) break;
        const next = directives[i];
        // A chain broken by a comment or another directive is left as written.
        if (!next?.text || directiveName(next.text).toLowerCase() !== "secrule") {
          isRaw = true;
          break;
        }
        lines.push(...next.lines);
        condition = parseCondition(next.text);
        if (!condition) isRaw = true;
        i += 1;
      }
      const source = lines.join("\n");
      if (isRaw) push({ kind: "raw", text: source }, lines);
      else {
        for (const c of conditions) c.actions = c.actions.filter((a) => !isChainAction(a));
        push({ kind: "rule", conditions }, lines);
      }
      continue;
    }

    if (lower === "secaction" || lower === "secdefaultaction") {
      const split = splitRuleDirective(directive.text);
      const actions = split ? parseActionList(split.actions) : [];
      if (!split || actions.length === 0) {
        push({ kind: "raw", text: directive.lines.join("\n") }, directive.lines);
      } else {
        push(
          { kind: lower === "secaction" ? "action" : "defaultAction", actions },
          directive.lines,
        );
      }
      i += 1;
      continue;
    }

    const argument = directive.text.slice(name.length).trim();
    push({ kind: "directive", name, argument }, directive.lines);
    i += 1;
  }

  // Trailing blank lines have no block to travel with; a last empty one keeps a final newline.
  if (gap > 0) entries.push({ block: { kind: "raw", text: "" }, source: "", gapBefore: gap - 1 });
  return entries;
}

// ---------------------------------------------------------------------------
// Writing blocks back
// ---------------------------------------------------------------------------

/** Past this a rule is written CRS-style, an action per line. */
const ONE_LINE_LIMIT = 100;
const CONTINUATION_INDENT = "    ";

export function formatVariable(variable: SeclangVariable): string {
  const prefix = `${variable.isCount ? "&" : ""}${variable.isExcluded ? "!" : ""}`;
  return `${prefix}${variable.name}${variable.key ? `:${variable.key}` : ""}`;
}

export function formatOperator(operator: SeclangOperator): string {
  const body = `${operator.isNegated ? "!" : ""}@${operator.name}`;
  return operator.argument ? `${body} ${operator.argument}` : body;
}

/** Values safe unquoted: no comma, quote, space or brace for Coraza to misread. */
const BARE_VALUE = /^[A-Za-z0-9_.\-/=!+%@*;]+$/;

export function formatAction(action: SeclangAction): string {
  // Coraza skips any character after a backslash, and `\\` is no escape, so a trailing one would
  // swallow the closing quote and every action after it. The field says it is left off.
  const raw = action.value.replace(/\\+$/, "");
  if (raw === "") return action.name;
  const value = BARE_VALUE.test(raw) ? raw : `'${raw.replace(/'/g, "\\'")}'`;
  return `${action.name}:${value}`;
}

function quoted(text: string): string {
  return `"${text.replace(/\\"/g, '"').replace(/"/g, '\\"')}"`;
}

function formatActionList(actions: readonly SeclangAction[], indent: string): string[] {
  const parts = actions.map(formatAction);
  const oneLine = `"${parts.join(",")}"`;
  if (oneLine.length <= ONE_LINE_LIMIT || parts.length < 2) return [oneLine];
  return parts.map((part, index) => {
    const open = index === 0 ? '"' : "";
    const close = index === parts.length - 1 ? '"' : ",\\";
    return `${indent}${open}${part}${close}`;
  });
}

function formatCondition(condition: SeclangCondition, isChained: boolean, depth: number): string {
  const indent = CONTINUATION_INDENT.repeat(depth);
  const actions = isChained
    ? [...condition.actions, { name: "chain", value: "" }]
    : condition.actions;
  const head = `${indent}SecRule ${condition.variables.map(formatVariable).join("|")} ${quoted(
    formatOperator(condition.operator),
  )}`;
  if (actions.length === 0) return head;
  const list = formatActionList(actions, indent + CONTINUATION_INDENT);
  if (list.length === 1 && head.length + list[0].length < ONE_LINE_LIMIT) {
    return `${head} ${list[0]}`;
  }
  if (list.length === 1) return `${head} \\\n${indent}${CONTINUATION_INDENT}${list[0]}`;
  return `${head} \\\n${list.join("\n")}`;
}

/** SecLang for one block, in the editor's house style. */
export function formatBlock(block: SeclangBlock): string {
  switch (block.kind) {
    case "rule":
      return block.conditions
        .map((condition, index) =>
          formatCondition(condition, index < block.conditions.length - 1, index === 0 ? 0 : 1),
        )
        .join("\n");
    case "action":
    case "defaultAction": {
      const head = block.kind === "action" ? "SecAction" : "SecDefaultAction";
      const list = formatActionList(block.actions, CONTINUATION_INDENT);
      return list.length === 1 ? `${head} ${list[0]}` : `${head} \\\n${list.join("\n")}`;
    }
    case "comment":
      return block.text
        .split("\n")
        .map((line) => (line ? `# ${line}` : "#"))
        .join("\n");
    case "directive":
      return block.argument ? `${block.name} ${block.argument}` : block.name;
    case "raw":
      return block.text;
  }
}

export function serializeSeclang(entries: readonly SeclangEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.gapBefore; i++) lines.push("");
    lines.push(entry.source);
  }
  return lines.join("\n");
}

/** The 1-based line each entry starts on and the number of lines it spans in `serializeSeclang`. */
export function entryLineSpans(
  entries: readonly SeclangEntry[],
): { start: number; length: number }[] {
  let line = 1;
  return entries.map((entry) => {
    line += entry.gapBefore;
    const length = entry.source.split("\n").length;
    const span = { start: line, length };
    line += length;
    return span;
  });
}

// ---------------------------------------------------------------------------
// Reading a block back to a person
// ---------------------------------------------------------------------------

/** First value of `name` among `actions`, case-insensitively. */
export function actionValue(actions: readonly SeclangAction[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return actions.find((action) => action.name.toLowerCase() === lower)?.value;
}

const DISRUPTIVE = ["deny", "block", "drop", "allow", "pass", "redirect"];

/** What a matching rule does to the request, for a summary line. */
export function disruptiveAction(actions: readonly SeclangAction[]): string | undefined {
  return actions.find((action) => DISRUPTIVE.includes(action.name.toLowerCase()))?.name;
}

export function blankCondition(): SeclangCondition {
  return {
    variables: [{ name: "REQUEST_URI", key: "", isExcluded: false, isCount: false }],
    operator: { isNegated: false, name: "contains", argument: "" },
    actions: [],
  };
}

/** A starter rule with the actions every custom rule wants. */
export function blankRule(id: number): SeclangBlock {
  const condition = blankCondition();
  condition.actions = [
    { name: "id", value: String(id) },
    { name: "phase", value: "2" },
    { name: "deny", value: "" },
    { name: "status", value: "403" },
    { name: "log", value: "" },
    { name: "msg", value: "" },
  ];
  return { kind: "rule", conditions: [condition] };
}

/** The next free id at or above `floor`, past every id already in `entries`. */
export function nextRuleId(entries: readonly SeclangEntry[], floor: number): number {
  let max = floor - 1;
  for (const { block } of entries) {
    const lists =
      block.kind === "rule"
        ? [block.conditions[0]?.actions ?? []]
        : block.kind === "action"
          ? [block.actions]
          : [];
    for (const actions of lists) {
      const id = Number(actionValue(actions, "id"));
      if (Number.isSafeInteger(id) && id > max) max = id;
    }
  }
  return max + 1;
}
