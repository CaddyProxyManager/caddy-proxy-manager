"use client";

/**
 * A transparent `<textarea>` over a highlighted `<pre>`, so editing behaviour stays the browser's
 * own. The layers share one box via `textLayer`; change one and the colours drift off the glyphs.
 */

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Field } from "@astryxdesign/core/Field";
import { useClipboard } from "@astryxdesign/core/hooks";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { ensureHighlightStyles } from "@astryxdesign/core/CodeBlock";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { LANGUAGE_LABELS, tokenizeCode, type CodeEditorLanguage } from "./code-syntax";

export type { CodeEditorLanguage };

export type CodeEditorIssue = {
  /** 1-based. */
  line: number;
  severity: "error" | "warning";
  message: string;
};

/** Past this the list says how many more rather than growing the form. */
const MAX_LISTED_ISSUES = 6;

const HEIGHTS = { sm: 160, md: 288, lg: 384 } as const;

const GUTTER = 44;
const PAD_X = 10;
const PAD_Y = 8;
const INDENT = "  ";
/** Gives an empty line a line box, so the highlighted layer keeps step with the textarea. */
const ZERO_WIDTH_SPACE = "​";

/** Everything that decides where a glyph lands; both layers must share it to wrap alike. */
const textLayer: CSSProperties = {
  margin: 0,
  border: 0,
  padding: `${PAD_Y}px ${PAD_X}px ${PAD_Y}px ${GUTTER}px`,
  fontFamily: "var(--font-family-code)",
  fontSize: "var(--font-size-sm)",
  lineHeight: 1.6,
  letterSpacing: "normal",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  wordBreak: "normal",
  tabSize: 2,
};

export type CodeEditorProps = {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  /** A hidden input carries the value under it. */
  htmlName?: string;
  language: CodeEditorLanguage;
  description?: string;
  placeholder?: string;
  isReadOnly?: boolean;
  isDisabled?: boolean;
  height?: keyof typeof HEIGHTS;
  /** For an editor whose name is already on screen; the label stays for screen readers. */
  isLabelHidden?: boolean;
  /** No border or rounding, for an editor filling a pane whose own dividers frame it. */
  isFlush?: boolean;
  isFooterHidden?: boolean;
  /** A copy button in the top corner, for a value meant to be pasted somewhere else. */
  isCopyable?: boolean;
  /** Floats over the editor's bottom corner, clear of the scrollbar: a Save button, say. */
  overlay?: ReactNode;
  issues?: readonly CodeEditorIssue[];
};

/** Varies by platform (0 where scrollbars overlay); keeps `overlay` off the scrollbar. */
function useScrollbarWidth(scroller: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth - el.clientWidth);
    measure();
    // Then it is measured once, and only a later-appearing scrollbar can be covered.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [scroller]);
  return width;
}

function Line({
  text,
  tokens,
  number,
  isPlaceholder = false,
  marker,
}: {
  text: string;
  tokens: { type: string; start: number; end: number }[];
  number: number;
  /** Dims the text but not the number, so an empty field still shows where line 1 is. */
  isPlaceholder?: boolean;
  marker?: CodeEditorIssue["severity"];
}) {
  const parts = [];
  let at = 0;

  for (const token of tokens) {
    // A tokenizer can return overlapping or out-of-order spans; skip rather than render nonsense.
    if (token.start < at || token.end > text.length) continue;
    if (token.start > at) parts.push(text.slice(at, token.start));
    parts.push(
      <span key={token.start} className={`astryx-token-${token.type}`}>
        {text.slice(token.start, token.end)}
      </span>,
    );
    at = token.end;
  }
  if (at < text.length) parts.push(text.slice(at));

  return (
    <span className="relative block">
      {/* Inline: placed by the gutter constants, coloured by the line's issue. */}
      <span
        style={{
          position: "absolute",
          left: `${PAD_X - GUTTER}px`,
          width: `${GUTTER - PAD_X * 2}px`,
          textAlign: "right",
          color: marker ? `var(--color-${marker})` : "var(--color-text-secondary)",
          fontWeight: marker ? 700 : undefined,
          userSelect: "none",
        }}
      >
        {number}
      </span>
      {isPlaceholder ? (
        <span className="cpm-code-editor-placeholder">{text || ZERO_WIDTH_SPACE}</span>
      ) : parts.length > 0 ? (
        parts
      ) : (
        ZERO_WIDTH_SPACE
      )}
    </span>
  );
}

export function CodeEditor({
  label,
  value,
  onChange,
  htmlName,
  language,
  description,
  placeholder,
  isReadOnly,
  isDisabled,
  height = "md",
  isLabelHidden,
  isFlush,
  isFooterHidden,
  isCopyable,
  overlay,
  issues = [],
}: CodeEditorProps) {
  const t = useTranslations("ui");
  const tCommon = useTranslations("common");
  const inputID = useId();
  const descriptionID = useId();

  // An insertion effect, as in CodeBlock: the token rules must exist before anything lays out.
  useInsertionEffect(() => ensureHighlightStyles(), []);

  const readOnly = Boolean(isReadOnly || isDisabled);
  // Number the placeholder's lines too, or the empty gutter reads as padding.
  const showsPlaceholder = value === "" && Boolean(placeholder);
  const lines = useMemo(
    () => (showsPlaceholder ? (placeholder ?? "") : value).split("\n"),
    [showsPlaceholder, placeholder, value],
  );
  const tokenLines = useMemo(() => tokenizeCode(value, language), [value, language]);
  const markers = useMemo(() => {
    const byLine = new Map<number, CodeEditorIssue["severity"]>();
    for (const issue of issues) {
      if (byLine.get(issue.line) !== "error") byLine.set(issue.line, issue.severity);
    }
    return byLine;
  }, [issues]);

  /**
   * Writing a textarea's value moves the caret to the end, so an indent restores it - in a layout
   * effect, since the new `value` round-trips through the parent first.
   */
  const pendingCaret = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollbarWidth = useScrollbarWidth(scrollerRef);
  const { copy, isCopied } = useClipboard({ announce: tCommon("copied") });
  // No clipboard API over plain http; the text stays selectable there.
  const [canCopy, setCanCopy] = useState(false);
  useEffect(() => setCanCopy(window.isSecureContext), []);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  });

  /** Tab indents; Escape then Tab leaves, so the form stays keyboard-reachable. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const { selectionStart, selectionEnd } = event.currentTarget;
    event.preventDefault();

    onChange?.(`${value.slice(0, selectionStart)}${INDENT}${value.slice(selectionEnd)}`);
    pendingCaret.current = selectionStart + INDENT.length;
  };

  return (
    <Field
      label={label}
      isLabelHidden={isLabelHidden}
      description={description}
      inputID={inputID}
      descriptionID={description ? descriptionID : undefined}
      isDisabled={isDisabled}
    >
      {/* The only thing the form reads. Disabled submits nothing, as a native control would. */}
      {htmlName && !isDisabled && <input type="hidden" name={htmlName} value={value} />}

      {/* Ring on the frame, scrolling inside it, so the scrollbar cannot paint over the ring. */}
      <div
        className="cpm-code-editor"
        data-flush={isFlush ? "" : undefined}
        data-disabled={isDisabled ? "" : undefined}
        style={{
          height: `${HEIGHTS[height]}px`,
          // Measured: read by .cpm-code-editor-overlay to keep floated content off the scrollbar.
          ["--cpm-scrollbar-gutter" as string]: `${scrollbarWidth}px`,
        }}
      >
        <div ref={scrollerRef} className="cpm-code-editor-scroller">
          <div className="cpm-code-editor-content">
            {/* Content-tall, so it scrolls with the numbers; inline, as gutter geometry. */}
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: `${GUTTER - PAD_X / 2}px`,
                borderRight: "1px solid var(--color-border)",
                pointerEvents: "none",
              }}
            />
            <pre
              aria-hidden="true"
              // A page translator would rewrite the directives into a Caddyfile that won't parse.
              translate="no"
              style={{ ...textLayer, color: "var(--color-text-primary)", pointerEvents: "none" }}
            >
              <code>
                {lines.map((line, index) => (
                  <Line
                    // biome-ignore lint/suspicious/noArrayIndexKey: a line is its position
                    key={index}
                    text={line}
                    tokens={showsPlaceholder ? [] : (tokenLines[index] ?? [])}
                    number={index + 1}
                    isPlaceholder={showsPlaceholder}
                    marker={showsPlaceholder ? undefined : markers.get(index + 1)}
                  />
                ))}
              </code>
            </pre>

            <textarea
              ref={textareaRef}
              id={inputID}
              aria-describedby={description ? descriptionID : undefined}
              // A read-only field never takes Tab.
              aria-keyshortcuts={readOnly ? undefined : "Tab Escape"}
              value={value}
              onChange={(event) => onChange?.(event.target.value)}
              onKeyDown={readOnly ? undefined : handleKeyDown}
              readOnly={readOnly}
              disabled={isDisabled}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              // Grammarly's injected overlay would push the text off its highlighting.
              data-gramm="false"
              style={{
                ...textLayer,
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                resize: "none",
                outline: "none",
                background: "transparent",
                // The <pre> underneath shows the glyphs; this layer is caret, selection and events.
                color: "transparent",
                caretColor: "var(--color-text-primary)",
                overflow: "hidden",
              }}
            />
          </div>
        </div>
        {isCopyable && canCopy && (
          <div className="cpm-code-editor-copy">
            <IconButton
              variant="ghost"
              size="sm"
              icon={isCopied ? <Check /> : <Copy />}
              tooltip={t("codeEditor.copy")}
              label={isCopied ? tCommon("copied") : t("codeEditor.copy")}
              onClick={() => void copy(value)}
            />
          </div>
        )}
        {overlay && <div className="cpm-code-editor-overlay">{overlay}</div>}
      </div>

      {issues.length > 0 && (
        <VStack gap={1} role="list" aria-label={t("codeEditor.issuesLabel")}>
          {issues.slice(0, MAX_LISTED_ISSUES).map((issue, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two issues can share a line and a message
            <HStack key={index} gap={2} align="center" role="listitem">
              <StatusDot
                variant={issue.severity}
                label={t(
                  issue.severity === "error" ? "codeEditor.errorLabel" : "codeEditor.warningLabel",
                )}
              />
              <Text type="body" size="xsm">
                {t("codeEditor.issueAt", { line: String(issue.line), message: issue.message })}
              </Text>
            </HStack>
          ))}
          {issues.length > MAX_LISTED_ISSUES && (
            <Text type="body" size="xsm" color="secondary">
              {t("codeEditor.moreIssues", { count: issues.length - MAX_LISTED_ISSUES })}
            </Text>
          )}
        </VStack>
      )}

      {/* Tab-to-indent must be discoverable in the open, not only via `aria-keyshortcuts`. */}
      {!isFooterHidden && (
        <HStack justify="between" gap={2}>
          <Text type="body" size="xsm" color="secondary">
            {readOnly ? "" : t("codeEditor.keyboardHint")}
          </Text>
          <Text type="body" size="xsm" color="secondary">
            {language === "plaintext" ? t("codeEditor.plaintextLabel") : LANGUAGE_LABELS[language]}
          </Text>
        </HStack>
      )}
    </Field>
  );
}
