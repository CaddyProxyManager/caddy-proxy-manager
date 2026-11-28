"use client";

/**
 * SecLang as a list of blocks with fields. Owns no text of its own: every edit re-emits the
 * block it touched and hands the joined text up, and text from outside is parsed afresh.
 */

import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { CodeEditor, type CodeEditorIssue } from "@/components/ui/CodeEditor";
import { withRowId, type WithRowId } from "@/lib/forms/row-id";
import {
  actionValue,
  blankRule,
  disruptiveAction,
  entryLineSpans,
  formatBlock,
  formatOperator,
  formatVariable,
  nextRuleId,
  parseSeclang,
  type SeclangBlock,
  type SeclangEntry,
  serializeSeclang,
} from "@/lib/waf/seclang-model";
import {
  ActionFields,
  CommentFields,
  DirectiveFields,
  RuleFields,
  tagBlock,
  useTermOptions,
} from "./SeclangBlockFields";
import { moved, useDragReorder } from "./use-drag-reorder";
import { useSeclangAssist } from "./use-seclang-assist";

type Entry = WithRowId<SeclangEntry>;

/** The empty block parseSeclang ends on to keep trailing blank lines; never shown. */
const isTrailer = (entry: SeclangEntry) => entry.block.kind === "raw" && entry.source === "";

function toEntries(text: string): Entry[] {
  return parseSeclang(text).map((entry) => withRowId({ ...entry, block: tagBlock(entry.block) }));
}

const BLOCK_COLORS = {
  rule: "blue",
  action: "purple",
  defaultAction: "orange",
  comment: "gray",
  directive: "teal",
  raw: "yellow",
} as const;

type Props = {
  value: string;
  onChange: (value: string) => void;
  issues: readonly CodeEditorIssue[];
  isReadOnly: boolean;
  /** Where new rule ids start: custom rules keep clear of the CRS's own. */
  idFloor: number;
};

export function SeclangVisualEditor({ value, onChange, issues, isReadOnly, idFloor }: Props) {
  const t = useTranslations("seclang");
  const tCommon = useTranslations("common");
  const tUi = useTranslations("ui");
  const options = useTermOptions();

  const [entries, setEntries] = useState<Entry[]>(() => toEntries(value));
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  /** The text the entries stand for: its own echo is not parsed back, anything else is. */
  const [parsed, setParsed] = useState(value);
  if (value !== parsed) {
    setParsed(value);
    setEntries(toEntries(value));
  }

  const commit = (next: Entry[]) => {
    const text = serializeSeclang(next);
    setEntries(next);
    setParsed(text);
    onChange(text);
  };

  const updateBlock = (rowId: string, block: SeclangBlock) =>
    commit(
      entries.map((entry) =>
        entry.rowId === rowId ? { ...entry, block, source: formatBlock(block) } : entry,
      ),
    );

  const add = (block: SeclangBlock) => {
    const entry = withRowId({ block: tagBlock(block), source: formatBlock(block), gapBefore: 0 });
    // Before the invisible trailer, and a blank line from a rule above it, as people write them.
    const at =
      entries.length > 0 && isTrailer(entries[entries.length - 1])
        ? entries.length - 1
        : entries.length;
    if (at > 0 && block.kind !== "comment") entry.gapBefore = 1;
    commit([...entries.slice(0, at), entry, ...entries.slice(at)]);
    setOpenIds((ids) => new Set(ids).add(entry.rowId));
  };

  const visible = entries.filter((entry) => !isTrailer(entry));
  const reorder = useDragReorder((from, to) => {
    const trailer = entries.filter(isTrailer);
    const next = moved(visible, from, to);
    // A block moved to the top would otherwise carry a blank line there.
    if (next[0] && next[0].gapBefore > 0) next[0] = { ...next[0], gapBefore: 0 };
    commit([...next, ...trailer]);
  }, "blocks");

  const issuesByRow = useMemo(() => {
    const spans = entryLineSpans(entries);
    const byRow = new Map<string, CodeEditorIssue[]>();
    for (const issue of issues) {
      const index = spans.findIndex(
        (span) => issue.line >= span.start && issue.line < span.start + span.length,
      );
      const rowId = entries[index]?.rowId;
      if (rowId) byRow.set(rowId, [...(byRow.get(rowId) ?? []), issue]);
    }
    return byRow;
  }, [entries, issues]);
  const issuesOf = (entry: Entry) => issuesByRow.get(entry.rowId) ?? [];

  const toggle = (rowId: string) =>
    setOpenIds((ids) => {
      const next = new Set(ids);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });

  const addMenu = !isReadOnly && (
    <HStack>
      <DropdownMenu
        button={{ variant: "secondary", size: "sm", icon: <Plus />, label: tCommon("add") }}
        items={[
          {
            id: "rule",
            label: t("visual.blockKinds.rule"),
            description: t("reference.directives.secRule"),
            onClick: () => add(blankRule(nextRuleId(entries, idFloor))),
          },
          {
            id: "action",
            label: t("visual.blockKinds.action"),
            description: t("reference.directives.secAction"),
            onClick: () =>
              add({
                kind: "action",
                actions: [
                  { name: "id", value: String(nextRuleId(entries, idFloor)) },
                  { name: "phase", value: "1" },
                  { name: "pass", value: "" },
                  { name: "nolog", value: "" },
                ],
              }),
          },
          {
            id: "comment",
            label: t("visual.blockKinds.comment"),
            description: t("visual.commentHelp"),
            onClick: () => add({ kind: "comment", text: "" }),
          },
          {
            id: "directive",
            label: t("visual.blockKinds.directive"),
            description: t("visual.directiveHelp"),
            onClick: () => add({ kind: "directive", name: "SecMarker", argument: "END" }),
          },
        ]}
      />
    </HStack>
  );

  if (visible.length === 0) {
    return (
      <Card>
        <VStack gap={3} hAlign="center">
          <EmptyState title={t("visual.empty")} />
          {addMenu}
        </VStack>
      </Card>
    );
  }

  return (
    <VStack gap={2}>
      <Text type="supporting">{t("visual.orderHelp")}</Text>
      <Card padding={0}>
        <VStack gap={0} role="list" aria-label={t("visual.listLabel")}>
          {visible.map((entry, index) => {
            const isOpen = openIds.has(entry.rowId);
            const blockIssues = issuesOf(entry);
            const worst = blockIssues.some((i) => i.severity === "error") ? "error" : "warning";
            return (
              <VStack
                key={entry.rowId}
                gap={0}
                role="listitem"
                {...reorder.rowProps(index)}
                className={reorder.dragging === index ? "opacity-50" : undefined}
              >
                {index > 0 && <Divider />}
                {/* The chevron is the keyboard control; a click anywhere else on the row is the
                    mouse shortcut, leaving the row's own buttons to do their own thing. */}
                <HStack
                  gap={2}
                  vAlign="center"
                  className="cpm-seclang-block-row"
                  onClick={(event) => {
                    if ((event.target as Element).closest("button, a, input")) return;
                    // A drag-select of the summary text is not a click to open.
                    if (window.getSelection()?.toString()) return;
                    toggle(entry.rowId);
                  }}
                >
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="cursor-grab"
                    icon={<GripVertical />}
                    label={t("visual.moveLabel", { index: index + 1 })}
                    tooltip={t("visual.move")}
                    isDisabled={isReadOnly || visible.length < 2}
                    {...reorder.handleProps(index, visible.length)}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={isOpen ? <ChevronDown /> : <ChevronRight />}
                    label={isOpen ? t("visual.collapse") : tCommon("edit")}
                    aria-expanded={isOpen}
                    onClick={() => toggle(entry.rowId)}
                  />
                  <Token
                    size="sm"
                    color={BLOCK_COLORS[entry.block.kind]}
                    label={t(
                      `visual.blockKinds.${
                        entry.block.kind === "rule" && entry.block.conditions.length > 1
                          ? "chain"
                          : entry.block.kind
                      }`,
                    )}
                  />
                  <BlockSummary block={entry.block} source={entry.source} />
                  {blockIssues.length > 0 && (
                    <HStack gap={1} vAlign="center">
                      <StatusDot
                        variant={worst}
                        label={t("visual.issueCount", { count: blockIssues.length })}
                      />
                      <Text type="body" size="sm" color="secondary">
                        {t("visual.issueCount", { count: blockIssues.length })}
                      </Text>
                    </HStack>
                  )}
                  {!isReadOnly && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 />}
                      label={t("visual.removeBlock", { index: index + 1 })}
                      tooltip={tCommon("remove")}
                      onClick={() => commit(entries.filter((e) => e.rowId !== entry.rowId))}
                    />
                  )}
                </HStack>
                {isOpen && (
                  <VStack gap={4} className="cpm-seclang-block-body">
                    {blockIssues.length > 0 && (
                      <VStack gap={1}>
                        {blockIssues.map((issue, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: two issues can share a line and a message
                          <HStack key={i} gap={2} vAlign="center">
                            <StatusDot
                              variant={issue.severity}
                              label={tUi(
                                issue.severity === "error"
                                  ? "codeEditor.errorLabel"
                                  : "codeEditor.warningLabel",
                              )}
                            />
                            <Text type="body" size="sm">
                              {issue.message}
                            </Text>
                          </HStack>
                        ))}
                      </VStack>
                    )}
                    <BlockFields
                      block={entry.block}
                      onChange={(block) => updateBlock(entry.rowId, block)}
                      options={options}
                      isReadOnly={isReadOnly}
                    />
                    {entry.block.kind !== "raw" && entry.block.kind !== "comment" && (
                      <CodeEditor
                        label={t("visual.generated")}
                        language="seclang"
                        value={entry.source}
                        isReadOnly
                        isCopyable
                        isFooterHidden
                        height="sm"
                      />
                    )}
                  </VStack>
                )}
              </VStack>
            );
          })}
        </VStack>
      </Card>
      {addMenu}
    </VStack>
  );
}

function BlockFields({
  block,
  onChange,
  options,
  isReadOnly,
}: {
  block: SeclangBlock;
  onChange: (block: SeclangBlock) => void;
  options: ReturnType<typeof useTermOptions>;
  isReadOnly: boolean;
}) {
  const shared = { options, isReadOnly };
  switch (block.kind) {
    case "rule":
      return <RuleFields block={block} onChange={onChange} {...shared} />;
    case "action":
    case "defaultAction":
      return <ActionFields block={block} onChange={onChange} {...shared} />;
    case "comment":
      return <CommentFields block={block} onChange={onChange} {...shared} />;
    case "directive":
      return <DirectiveFields block={block} onChange={onChange} {...shared} />;
    case "raw":
      return <RawFields block={block} onChange={onChange} isReadOnly={isReadOnly} />;
  }
}

function RawFields({
  block,
  onChange,
  isReadOnly,
}: {
  block: Extract<SeclangBlock, { kind: "raw" }>;
  onChange: (block: SeclangBlock) => void;
  isReadOnly: boolean;
}) {
  const t = useTranslations("seclang");
  const assist = useSeclangAssist();
  return (
    <CodeEditor
      label={t("visual.rawLabel")}
      description={t("visual.rawHelp")}
      language="seclang"
      value={block.text}
      onChange={(text) => onChange({ kind: "raw", text })}
      isReadOnly={isReadOnly}
      height="sm"
      assist={assist}
    />
  );
}

/** One line on what the block does: its id, what it inspects, and what it does on a match. */
function BlockSummary({ block, source }: { block: SeclangBlock; source: string }) {
  const t = useTranslations("seclang");
  const tWaf = useTranslations("waf");
  let title: ReactNode;
  let detail: ReactNode = null;
  let note: string | undefined;

  switch (block.kind) {
    case "rule": {
      const [first] = block.conditions;
      const actions = first?.actions ?? [];
      const id = actionValue(actions, "id");
      title = id ? tWaf("ruleLabel", { id }) : t("visual.ruleTitleNoId");
      const outcome = disruptiveAction(actions);
      const status = actionValue(actions, "status");
      detail = first && (
        <>
          <Code>{first.variables.map(formatVariable).join("|")}</Code>
          <Code>{formatOperator(first.operator)}</Code>
          {outcome && <Code>{status ? `${outcome} ${status}` : outcome}</Code>}
          {block.conditions.length > 1 && (
            <Text type="body" size="sm" color="secondary">
              {t("visual.summaryAnd", { count: block.conditions.length - 1 })}
            </Text>
          )}
        </>
      );
      note = actionValue(actions, "msg");
      break;
    }
    case "action": {
      const id = actionValue(block.actions, "id");
      title = id ? t("visual.actionTitle", { id }) : t("visual.blockKinds.action");
      note = t("visual.summaryAlways");
      break;
    }
    case "defaultAction":
      title = t("visual.defaultActionTitle", {
        phase: actionValue(block.actions, "phase") ?? "?",
      });
      detail = <Code>{block.actions.map((a) => a.name).join(",")}</Code>;
      break;
    case "comment":
      title = block.text.split("\n")[0] || "#";
      break;
    case "directive":
      title = <Code>{block.argument ? `${block.name} ${block.argument}` : block.name}</Code>;
      break;
    case "raw":
      title = <Code>{source.split("\n")[0]?.trim() || "…"}</Code>;
      break;
  }

  return (
    <HStack gap={2} vAlign="center" wrap="wrap" className="cpm-seclang-block-summary">
      <Text type="body" size="sm" weight="semibold" maxLines={1}>
        {title}
      </Text>
      {detail}
      {note && (
        <Text type="body" size="sm" color="secondary" maxLines={1}>
          {note}
        </Text>
      )}
    </HStack>
  );
}
