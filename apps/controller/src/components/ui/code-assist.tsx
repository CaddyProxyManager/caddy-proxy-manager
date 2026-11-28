"use client";

/**
 * Suggestions at the caret and an explanation under the pointer, for CodeEditor. Both float in
 * the top layer as manual popovers: the editor's frame clips, and a dialog would cover them.
 */

import {
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";

export type CodeCompletion = {
  label: string;
  /** Replaces `from`..`to`; a trailing `:` or space reopens the list for what follows. */
  insert: string;
  kind: string;
  description?: string;
};

export type CodeCompletions = { from: number; to: number; items: CodeCompletion[] };

export type CodeDescription = { title: string; kind: string; description: string };

export type CodeAssist = {
  complete: (text: string, caret: number) => CodeCompletions | null;
  describe: (text: string, offset: number) => CodeDescription | null;
  /** Shown in the footer, beside the indent hint. */
  hint?: string;
  /** Names the suggestion list for screen readers. */
  listLabel?: string;
};

/** A line box in viewport coordinates: the popup goes below it, or above when that overflows. */
type Point = { left: number; top: number; bottom: number };

const HOVER_DELAY_MS = 350;
const POPUP_GAP = 4;

function supportsPopover(): boolean {
  return typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;
}

/** Copied onto the mirror so it wraps exactly as the textarea does. */
const MIRRORED = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
  "tabSize",
] as const;

/** Where each line starts, then the text's length + 1 after the last. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  starts.push(text.length + 1);
  return starts;
}

/** The line holding `offset`: the last start at or before it. */
function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Viewport position of the caret's line bottom, measured on a hidden copy of the caret's line
 * placed where the highlighted layer draws it: copying all the text before it lays out per key.
 */
function caretPoint(
  textarea: HTMLTextAreaElement,
  code: HTMLElement | null,
  starts: readonly number[],
  position: number,
): Point | null {
  const host = textarea.parentElement;
  if (!host) return null;
  const index = lineOf(starts, position);
  const line = code?.children[index];
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const name of MIRRORED) mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "0",
    border: "0",
    margin: "0",
  });
  let from = 0;
  if (line) {
    from = starts[index];
    mirror.style.paddingTop = "0";
    mirror.style.paddingBottom = "0";
    mirror.style.top = `${line.getBoundingClientRect().top - host.getBoundingClientRect().top}px`;
  }
  mirror.textContent = textarea.value.slice(from, position);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  host.appendChild(mirror);
  const rect = marker.getBoundingClientRect();
  mirror.remove();
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

/**
 * The text offset under a viewport point, read off the highlighted layer: the textarea on top
 * reports no character positions. Null between lines or past a line's end.
 */
function offsetAtPoint(
  code: HTMLElement,
  starts: readonly number[],
  x: number,
  y: number,
): { offset: number; rect: DOMRect } | null {
  const lines = code.children;
  // Lines stack top to bottom, so a binary search finds the one under y in a few rect reads.
  let lo = 0;
  let hi = Math.min(lines.length, starts.length - 1) - 1;
  while (lo <= hi) {
    const index = (lo + hi) >> 1;
    const line = lines[index] as HTMLElement;
    const box = line.getBoundingClientRect();
    if (y < box.top) {
      hi = index - 1;
      continue;
    }
    if (y > box.bottom) {
      lo = index + 1;
      continue;
    }
    const lineStart = starts[index];
    const length = starts[index + 1] - lineStart - 1;
    // The first child is the line number.
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let column = 0;
    let node = walker.nextNode();
    if (line.firstChild?.contains(node)) node = walker.nextNode();
    while (node && column < length) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length && column < length; i++, column++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        for (const rect of range.getClientRects()) {
          if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
            return { offset: lineStart + column, rect };
          }
        }
      }
      node = walker.nextNode();
    }
    return null;
  }
  return null;
}

/** Shows a manual popover while `isOpen`, placed at `point`. */
function useTopLayer(isOpen: boolean, point: Point | null) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !point) return;
    el.style.left = `${Math.max(POPUP_GAP, Math.min(point.left, window.innerWidth - el.offsetWidth - POPUP_GAP))}px`;
    const below = point.bottom + POPUP_GAP;
    el.style.top =
      below + el.offsetHeight > window.innerHeight
        ? `${Math.max(POPUP_GAP, point.top - el.offsetHeight - POPUP_GAP)}px`
        : `${below}px`;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isOpen && !el.matches(":popover-open")) el.showPopover();
    if (!isOpen && el.matches(":popover-open")) el.hidePopover();
  }, [isOpen]);
  return ref;
}

type AssistState = {
  completions: (CodeCompletions & { active: number; point: Point | null }) | null;
  hover: (CodeDescription & { point: Point }) | null;
};

export function useCodeAssist({
  assist,
  value,
  onChange,
  textareaRef,
  codeRef,
  setCaret,
  isEnabled,
}: {
  assist: CodeAssist | undefined;
  value: string;
  onChange: ((value: string) => void) | undefined;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  codeRef: RefObject<HTMLElement | null>;
  setCaret: (caret: number) => void;
  isEnabled: boolean;
}) {
  const [state, setState] = useState<AssistState>({ completions: null, hover: null });
  const starts = useMemo(() => lineStartsOf(value), [value]);
  const listId = useId();
  // Known only in the browser; checked after hydration so the server's markup matches.
  const [canFloat, setCanFloat] = useState(false);
  useEffect(() => setCanFloat(supportsPopover()), []);
  const available = Boolean(assist) && isEnabled && canFloat;

  const close = useCallback(() => setState((s) => ({ ...s, completions: null })), []);

  const open = useCallback(
    (text: string, caret: number) => {
      if (!assist || !available) return;
      const result = assist.complete(text, caret);
      const textarea = textareaRef.current;
      setState(() => ({
        hover: null,
        completions:
          result && textarea
            ? {
                ...result,
                active: 0,
                point: caretPoint(textarea, codeRef.current, lineStartsOf(text), result.from),
              }
            : null,
      }));
    },
    [assist, available, textareaRef, codeRef],
  );

  const accept = (index: number) => {
    const completions = state.completions;
    const item = completions?.items[index];
    if (!completions || !item || !onChange) return;
    const next = value.slice(0, completions.from) + item.insert + value.slice(completions.to);
    const caret = completions.from + item.insert.length;
    onChange(next);
    setCaret(caret);
    if (/[:= ]$/.test(item.insert) || item.insert.endsWith(".")) {
      // The textarea updates after this render; measure against the new text there.
      requestAnimationFrame(() => open(next, caret));
    } else close();
  };

  /** Call from the textarea's onChange with the event's input type. */
  const onInput = (text: string, caret: number, inputType: string) => {
    if (!available) return;
    if (inputType === "insertText" || (inputType.startsWith("delete") && state.completions)) {
      open(text, caret);
    } else close();
  };

  /** True when the key was the list's. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!available) return false;
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      open(value, event.currentTarget.selectionStart);
      return true;
    }
    if (state.hover) setState((s) => ({ ...s, hover: null }));
    const completions = state.completions;
    if (!completions) return false;
    const count = completions.items.length;
    const move = (by: number) =>
      setState((s) =>
        s.completions
          ? {
              ...s,
              completions: {
                ...s.completions,
                active: (s.completions.active + by + count) % count,
              },
            }
          : s,
      );
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "PageDown":
        move(Math.min(8, count - 1 - completions.active));
        break;
      case "PageUp":
        move(-Math.min(8, completions.active));
        break;
      case "Enter":
      case "Tab":
        accept(completions.active);
        break;
      case "Escape":
        close();
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  };

  // The caret leaving the word, by click or arrow key, ends the suggestion.
  const onSelect = () => {
    const textarea = textareaRef.current;
    const completions = state.completions;
    if (!textarea || !completions) return;
    const caret = textarea.selectionStart;
    if (
      caret < completions.from ||
      caret > completions.from + 64 ||
      textarea.selectionEnd !== caret
    ) {
      close();
    }
  };

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverFrame = useRef<number | null>(null);
  const clearHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setState((s) => (s.hover ? { ...s, hover: null } : s));
  }, []);

  const onMouseMove = (event: MouseEvent<HTMLTextAreaElement>) => {
    if (!available || !assist || state.completions || event.buttons !== 0) return;
    const { clientX, clientY } = event;
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      const code = codeRef.current;
      if (!code) return;
      const hit = offsetAtPoint(code, starts, clientX, clientY);
      const description = hit && assist.describe(value, hit.offset);
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (!description || !hit) {
        hoverTimer.current = null;
        setState((s) => (s.hover ? { ...s, hover: null } : s));
        return;
      }
      if (state.hover?.title === description.title) return;
      hoverTimer.current = setTimeout(() => {
        setState((s) => ({
          ...s,
          hover: {
            ...description,
            point: { left: hit.rect.left, top: hit.rect.top, bottom: hit.rect.bottom },
          },
        }));
      }, HOVER_DELAY_MS);
    });
  };

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );

  const activeId = state.completions ? `${listId}-${state.completions.active}` : undefined;

  return {
    isAvailable: available,
    textareaProps: available
      ? {
          "aria-autocomplete": "list" as const,
          "aria-controls": state.completions ? listId : undefined,
          "aria-activedescendant": activeId,
          onMouseMove,
          onMouseLeave: clearHover,
          onSelect,
          onBlur: () => {
            close();
            clearHover();
          },
        }
      : {},
    onInput,
    onKeyDown,
    onScroll: () => {
      close();
      clearHover();
    },
    popups: available ? (
      <>
        <CompletionList
          listId={listId}
          completions={state.completions}
          label={assist?.listLabel}
          onPick={accept}
        />
        <HoverCard hover={state.hover} />
      </>
    ) : null,
  };
}

function CompletionList({
  listId,
  completions,
  label,
  onPick,
}: {
  listId: string;
  completions: AssistState["completions"];
  label?: string;
  onPick: (index: number) => void;
}) {
  const ref = useTopLayer(Boolean(completions), completions?.point ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = completions?.items[completions.active];

  useEffect(() => {
    if (!completions) return;
    listRef.current
      ?.querySelector(`[data-index="${completions.active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [completions]);

  return (
    <div ref={ref} popover="manual" className="cpm-code-assist">
      {completions && (
        <VStack gap={0}>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className="cpm-code-assist-list"
          >
            {completions.items.map((item, index) => (
              <div
                key={item.label}
                // Reached through aria-activedescendant; focus stays in the textarea.
                tabIndex={-1}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === completions.active}
                className="cpm-code-assist-option"
                // Keeps focus, and with it the caret, in the textarea.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(index);
                }}
              >
                <HStack justify="between" gap={3} vAlign="center">
                  <code>{item.label}</code>
                  <Text type="body" size="sm" color="secondary">
                    {item.kind}
                  </Text>
                </HStack>
              </div>
            ))}
          </div>
          {active?.description && (
            <div className="cpm-code-assist-detail">
              <Text type="body" size="sm">
                {active.description}
              </Text>
            </div>
          )}
        </VStack>
      )}
    </div>
  );
}

function HoverCard({ hover }: { hover: AssistState["hover"] }) {
  const ref = useTopLayer(Boolean(hover), hover?.point ?? null);
  return (
    <div
      ref={ref}
      popover="manual"
      role="tooltip"
      className="cpm-code-assist cpm-code-assist-hover"
    >
      {hover && (
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <code>{hover.title}</code>
            <Text type="body" size="sm" color="secondary">
              {hover.kind}
            </Text>
          </HStack>
          <Text type="body" size="sm">
            {hover.description}
          </Text>
        </VStack>
      )}
    </div>
  );
}
