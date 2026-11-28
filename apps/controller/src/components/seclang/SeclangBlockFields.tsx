"use client";

/** The fields of one SecLang block in the visual editor. Each edit hands back a whole new block. */

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { GripVertical, MinusCircle, Plus, Trash2 } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { InfoTip } from "@astryxdesign/core/InfoTip";
import { Selector } from "@astryxdesign/core/Selector";
import type { SelectorOptionData } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import {
  ACTION_VALUES,
  ALLOWED_SECLANG_DIRECTIVES,
  ALLOWED_SETTING_DIRECTIVES,
  OPERATOR_FAMILIES,
  ARGUMENTLESS_OPERATORS,
  DIRECTIVE_VALUES,
  SECLANG_ACTIONS,
  SECLANG_DIRECTIVES,
  SECLANG_OPERATORS,
  SECLANG_VARIABLES,
  type SeclangTermKind,
  actionSpec,
  canonicalTerm,
  isSelectableVariable,
} from "@/lib/waf/seclang-reference";
import {
  blankCondition,
  type SeclangAction,
  type SeclangBlock,
  type SeclangCondition,
  type SeclangVariable,
} from "@/lib/waf/seclang-model";
import { withRowId, type WithRowId } from "@/lib/forms/row-id";
import { moved, useDragReorder } from "./use-drag-reorder";
import { useTermDescription } from "./use-seclang-assist";

type Row<T> = T & { rowId?: string };

type TagColor =
  | "red"
  | "purple"
  | "blue"
  | "teal"
  | "green"
  | "yellow"
  | "cyan"
  | "orange"
  | "gray";

/** One colour per kind, on a row's edge and its tag; the CSS keys off `data-color`. */
const ACTION_KIND_COLORS: Record<string, TagColor> = {
  disruptive: "red",
  flow: "purple",
  metadata: "blue",
  data: "teal",
  nondisruptive: "green",
  unknown: "yellow",
};

const VARIABLE_KIND_COLORS: Record<string, TagColor> = {
  collection: "teal",
  single: "blue",
  count: "orange",
  unknown: "yellow",
};

const OPERATOR_FAMILY_COLORS: Record<string, TagColor> = {
  text: "blue",
  pattern: "purple",
  number: "teal",
  address: "cyan",
  detection: "red",
  validation: "orange",
  constant: "gray",
};

/** Two levels inside an open block: a rule's conditions, then the parts of each. */
function SectionHeading({ level, title, help }: { level: 3 | 4; title: string; help?: string }) {
  return (
    <VStack gap={1}>
      <Heading level={level}>{title}</Heading>
      {help && <Text type="supporting">{help}</Text>}
    </VStack>
  );
}

/** A kind tag and what the chosen term does, under a row of fields. */
function Explanation({ color, tag, text }: { color: TagColor; tag: string; text: string }) {
  return (
    <HStack gap={2} vAlign="center">
      <Token size="sm" color={color} label={tag} />
      <Text type="supporting" size="sm" color="secondary">
        {text}
      </Text>
    </HStack>
  );
}

/** Options for each term kind, described from the catalog; built once per editor. */
export type TermOptions = Record<SeclangTermKind, SelectorOptionData[]>;

export function useTermOptions(): TermOptions {
  const describe = useTermDescription();
  return useMemo(() => {
    const options = (kind: SeclangTermKind, names: readonly string[]) =>
      names.map((name) => ({ value: name, label: name, description: describe(kind, name) }));
    return {
      directives: options(
        "directives",
        SECLANG_DIRECTIVES.filter((d) => d === "SecMarker" || !ALLOWED_SECLANG_DIRECTIVES.has(d)),
      ),
      variables: options("variables", SECLANG_VARIABLES),
      operators: options("operators", SECLANG_OPERATORS),
      actions: options(
        "actions",
        SECLANG_ACTIONS.map((a) => a.name).filter((name) => name !== "chain"),
      ),
      transformations: [],
    };
  }, [describe]);
}

/** The options, plus the current value when SecLang has no such name, so it still shows. */
function withCurrent(
  options: SelectorOptionData[],
  value: string,
  unknownLabel: string,
): SelectorOptionData[] {
  if (!value || options.some((option) => option.value === value)) return options;
  return [{ value, label: value, description: unknownLabel }, ...options];
}

const valueOptions = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));

type FieldsProps<B extends SeclangBlock> = {
  block: B;
  onChange: (block: B) => void;
  options: TermOptions;
  isReadOnly: boolean;
};

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

function VariableRows({
  variables,
  onChange,
  options,
  isReadOnly,
}: {
  variables: Row<SeclangVariable>[];
  onChange: (variables: Row<SeclangVariable>[]) => void;
  options: TermOptions;
  isReadOnly: boolean;
}) {
  const t = useTranslations("seclang");
  const describe = useTermDescription();
  const reorder = useDragReorder((from, to) => onChange(moved(variables, from, to)), "variables");
  const update = (index: number, patch: Partial<SeclangVariable>) =>
    onChange(variables.map((v, i) => (i === index ? { ...v, ...patch } : v)));

  return (
    <VStack gap={2}>
      <SectionHeading level={4} title={t("visual.variablesTitle")} />
      {variables.map((variable, index) => {
        const selectable = isSelectableVariable(variable.name);
        const description = describe("variables", variable.name);
        const kind = !description
          ? "unknown"
          : variable.isCount
            ? "count"
            : selectable
              ? "collection"
              : "single";
        return (
          <VStack
            key={variable.rowId ?? index}
            gap={1}
            {...reorder.rowProps(index)}
            data-color={VARIABLE_KIND_COLORS[kind]}
            className={`cpm-seclang-row${reorder.dragging === index ? " opacity-50" : ""}`}
          >
            <HStack gap={2} vAlign="end" wrap="wrap">
              <IconButton
                variant="ghost"
                size="sm"
                className="cursor-grab"
                icon={<GripVertical />}
                label={t("visual.moveLabel", { index: index + 1 })}
                tooltip={t("visual.move")}
                isDisabled={isReadOnly || variables.length < 2}
                {...reorder.handleProps(index, variables.length)}
              />
              <Selector
                label={t("kinds.variables")}
                isLabelHidden={index > 0}
                hasSearch
                width={240}
                options={withCurrent(options.variables, variable.name, t("visual.unknownTerm"))}
                value={variable.name}
                onChange={(name) =>
                  update(index, {
                    name,
                    ...(isSelectableVariable(name) ? {} : { key: "", isExcluded: false }),
                  })
                }
                isReadOnly={isReadOnly}
              />
              {selectable && (
                <TextInput
                  {...NO_SPELLCHECK}
                  label={t("visual.variableKey")}
                  isLabelHidden={index > 0}
                  labelTooltip={t("visual.variableKeyHelp")}
                  placeholder={t("visual.variableKeyPlaceholder")}
                  width={200}
                  value={variable.key}
                  onChange={(key) => update(index, { key, ...(key ? {} : { isExcluded: false }) })}
                  isReadOnly={isReadOnly}
                />
              )}
              {/* Sized like the inputs beside it, so the checkboxes sit on their baseline. */}
              <HStack gap={3} vAlign="center" className="cpm-seclang-checks">
                {selectable && variable.key && (
                  <HStack gap={1} vAlign="center">
                    <CheckboxInput
                      label={t("visual.excludeKey")}
                      value={variable.isExcluded}
                      onChange={(isExcluded) => update(index, { isExcluded })}
                      isReadOnly={isReadOnly}
                    />
                    <InfoTip content={t("visual.excludeHelp")} label={t("visual.excludeKey")} />
                  </HStack>
                )}
                <HStack gap={1} vAlign="center">
                  <CheckboxInput
                    label={t("visual.count")}
                    value={variable.isCount}
                    onChange={(isCount) => update(index, { isCount })}
                    isReadOnly={isReadOnly}
                  />
                  <InfoTip content={t("visual.countHelp")} label={t("visual.count")} />
                </HStack>
              </HStack>
              <IconButton
                variant="ghost"
                size="sm"
                icon={<MinusCircle />}
                label={t("visual.removeVariable", { index: index + 1 })}
                tooltip={t("visual.removeVariable", { index: index + 1 })}
                isDisabled={isReadOnly || variables.length < 2}
                onClick={() => onChange(variables.filter((_, i) => i !== index))}
              />
            </HStack>
            <Explanation
              color={VARIABLE_KIND_COLORS[kind]}
              tag={t(`variableKinds.${kind === "unknown" ? "single" : kind}`)}
              text={description ?? t("visual.unknownTerm")}
            />
          </VStack>
        );
      })}
      {!isReadOnly && (
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus />}
            label={t("kinds.variables")}
            onClick={() =>
              onChange([
                ...variables,
                withRowId({ name: "ARGS", key: "", isExcluded: false, isCount: false }),
              ])
            }
          />
        </HStack>
      )}
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function ActionRows({
  actions,
  onChange,
  options,
  isReadOnly,
  help,
  level,
}: {
  actions: Row<SeclangAction>[];
  onChange: (actions: Row<SeclangAction>[]) => void;
  options: TermOptions;
  isReadOnly: boolean;
  help?: string;
  level: 3 | 4;
}) {
  const t = useTranslations("seclang");
  const tCommon = useTranslations("common");
  const describe = useTermDescription();
  const reorder = useDragReorder((from, to) => onChange(moved(actions, from, to)), "actions");
  const update = (index: number, patch: Partial<SeclangAction>) =>
    onChange(actions.map((a, i) => (i === index ? { ...a, ...patch } : a)));

  return (
    <VStack gap={2}>
      <SectionHeading level={level} title={tCommon("actions")} help={help} />
      {actions.map((action, index) => {
        const spec = actionSpec(action.name);
        const lower = action.name.toLowerCase();
        const fixed = ACTION_VALUES[lower];
        const valueLabel = t("kinds.values");
        const description =
          lower === "t"
            ? describe("transformations", canonicalTerm("transformations", action.value) ?? "")
            : undefined;
        const kind = spec?.kind ?? "unknown";
        return (
          <VStack
            key={action.rowId ?? index}
            gap={1}
            {...reorder.rowProps(index)}
            data-color={ACTION_KIND_COLORS[kind]}
            className={`cpm-seclang-row${reorder.dragging === index ? " opacity-50" : ""}`}
          >
            <HStack gap={2} vAlign="end" wrap="wrap">
              <IconButton
                variant="ghost"
                size="sm"
                className="cursor-grab"
                icon={<GripVertical />}
                label={t("visual.moveAction", { index: index + 1 })}
                tooltip={t("visual.move")}
                isDisabled={isReadOnly || actions.length < 2}
                {...reorder.handleProps(index, actions.length)}
              />
              <Selector
                label={t("kinds.actions")}
                isLabelHidden={index > 0}
                hasSearch
                width={180}
                options={withCurrent(
                  options.actions,
                  spec?.name ?? action.name,
                  t("visual.unknownTerm"),
                )}
                value={spec?.name ?? action.name}
                onChange={(name) => {
                  const next = actionSpec(name);
                  update(index, {
                    name,
                    value: next?.argument === "none" ? "" : action.value,
                  });
                }}
                isReadOnly={isReadOnly}
              />
              {spec?.argument !== "none" &&
                (fixed ? (
                  <Selector
                    label={valueLabel}
                    isLabelHidden={index > 0}
                    hasSearch={fixed.length > 8}
                    width={220}
                    options={withCurrent(
                      valueOptions(fixed),
                      action.value,
                      t("visual.unknownTerm"),
                    )}
                    value={action.value || undefined}
                    placeholder={t("visual.actionValuePlaceholder")}
                    onChange={(value) => update(index, { value })}
                    isReadOnly={isReadOnly}
                  />
                ) : (
                  <TextInput
                    {...NO_SPELLCHECK}
                    label={valueLabel}
                    isLabelHidden={index > 0}
                    width={lower === "msg" || lower === "logdata" ? 360 : 220}
                    value={action.value}
                    placeholder={
                      spec?.argument === "optional" ? t("visual.actionValuePlaceholder") : undefined
                    }
                    onChange={(value) => update(index, { value })}
                    status={
                      action.value.endsWith("\\")
                        ? { type: "error", message: t("visual.trailingBackslash") }
                        : undefined
                    }
                    isReadOnly={isReadOnly}
                  />
                ))}
              <IconButton
                variant="ghost"
                size="sm"
                icon={<MinusCircle />}
                label={t("visual.removeAction", { index: index + 1 })}
                tooltip={t("visual.removeAction", { index: index + 1 })}
                isDisabled={isReadOnly}
                onClick={() => onChange(actions.filter((_, i) => i !== index))}
              />
            </HStack>
            <Explanation
              color={ACTION_KIND_COLORS[kind] ?? "yellow"}
              tag={kind === "unknown" ? t("unrecognised") : t(`actionKinds.${kind}`)}
              text={(spec && describe("actions", spec.name)) ?? t("visual.unknownTerm")}
            />
            {description && <Explanation color="green" tag={action.value} text={description} />}
          </VStack>
        );
      })}
      {!isReadOnly && (
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus />}
            label={t("kinds.actions")}
            onClick={() => onChange([...actions, withRowId({ name: "log", value: "" })])}
          />
        </HStack>
      )}
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function ConditionFields({
  condition,
  onChange,
  options,
  isReadOnly,
  isChained,
}: {
  condition: SeclangCondition;
  onChange: (condition: SeclangCondition) => void;
  options: TermOptions;
  isReadOnly: boolean;
  isChained: boolean;
}) {
  const t = useTranslations("seclang");
  const describe = useTermDescription();
  const { operator } = condition;
  const family = OPERATOR_FAMILIES[operator.name];
  return (
    <VStack gap={4}>
      <VariableRows
        variables={condition.variables}
        onChange={(variables) => onChange({ ...condition, variables })}
        options={options}
        isReadOnly={isReadOnly}
      />
      <VStack gap={2}>
        <SectionHeading level={4} title={t("visual.operatorTitle")} />
        <VStack
          gap={1}
          data-color={family ? OPERATOR_FAMILY_COLORS[family] : "yellow"}
          className="cpm-seclang-row"
        >
          <HStack gap={2} vAlign="end" wrap="wrap">
            <Selector
              label={t("kinds.operators")}
              hasSearch
              width={220}
              options={withCurrent(options.operators, operator.name, t("visual.unknownTerm"))}
              value={operator.name}
              onChange={(name) => onChange({ ...condition, operator: { ...operator, name } })}
              isReadOnly={isReadOnly}
            />
            <TextInput
              {...NO_SPELLCHECK}
              label={t("visual.operatorArgument")}
              width={320}
              value={operator.argument}
              isOptional={ARGUMENTLESS_OPERATORS.has(operator.name)}
              onChange={(argument) =>
                onChange({ ...condition, operator: { ...operator, argument } })
              }
              isReadOnly={isReadOnly}
            />
            <HStack gap={1} vAlign="center" className="cpm-seclang-checks">
              <CheckboxInput
                label={t("visual.negate")}
                value={operator.isNegated}
                onChange={(isNegated) =>
                  onChange({ ...condition, operator: { ...operator, isNegated } })
                }
                isReadOnly={isReadOnly}
              />
              <InfoTip content={t("visual.negateHelp")} label={t("visual.negate")} />
            </HStack>
          </HStack>
          <Explanation
            color={family ? OPERATOR_FAMILY_COLORS[family] : "yellow"}
            tag={family ? t(`operatorFamilies.${family}`) : t("unrecognised")}
            text={describe("operators", operator.name) ?? t("visual.unknownTerm")}
          />
        </VStack>
      </VStack>
      <ActionRows
        actions={condition.actions}
        onChange={(actions) => onChange({ ...condition, actions })}
        options={options}
        isReadOnly={isReadOnly}
        help={isChained ? t("visual.chainActionsHelp") : t("visual.actionsHelp")}
        level={4}
      />
    </VStack>
  );
}

export function RuleFields({
  block,
  onChange,
  options,
  isReadOnly,
}: FieldsProps<Extract<SeclangBlock, { kind: "rule" }>>) {
  const t = useTranslations("seclang");
  const setCondition = (index: number, condition: SeclangCondition) =>
    onChange({
      ...block,
      conditions: block.conditions.map((c, i) => (i === index ? condition : c)),
    });

  return (
    <VStack gap={4}>
      <SectionHeading
        level={3}
        title={t("visual.conditionsTitle")}
        help={t("visual.conditionsHelp")}
      />
      {block.conditions.map((condition, index) => (
        <VStack key={(condition as Row<SeclangCondition>).rowId ?? index} gap={3}>
          {index > 0 && (
            <>
              <Divider />
              <HStack justify="between" vAlign="start">
                <SectionHeading
                  level={3}
                  title={t("visual.chainTitle")}
                  help={t("visual.chainHelp")}
                />
                {!isReadOnly && (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 />}
                    label={t("visual.removeChain")}
                    tooltip={t("visual.removeChain")}
                    onClick={() =>
                      onChange({
                        ...block,
                        conditions: block.conditions.filter((_, i) => i !== index),
                      })
                    }
                  />
                )}
              </HStack>
            </>
          )}
          <ConditionFields
            condition={condition}
            onChange={(next) => setCondition(index, next)}
            options={options}
            isReadOnly={isReadOnly}
            isChained={index > 0}
          />
        </VStack>
      ))}
      {!isReadOnly && (
        <HStack>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus />}
            label={t("visual.blockKinds.chain")}
            onClick={() =>
              onChange({
                ...block,
                conditions: [...block.conditions, tagCondition(blankCondition())],
              })
            }
          />
        </HStack>
      )}
    </VStack>
  );
}

export function ActionFields({
  block,
  onChange,
  options,
  isReadOnly,
}: FieldsProps<Extract<SeclangBlock, { kind: "action" | "defaultAction" }>>) {
  const t = useTranslations("seclang");
  return (
    <ActionRows
      actions={block.actions}
      onChange={(actions) => onChange({ ...block, actions })}
      options={options}
      isReadOnly={isReadOnly}
      help={block.kind === "action" ? t("visual.actionsHelp") : undefined}
      level={3}
    />
  );
}

export function CommentFields({
  block,
  onChange,
  isReadOnly,
}: FieldsProps<Extract<SeclangBlock, { kind: "comment" }>>) {
  const t = useTranslations("seclang");
  return (
    <TextArea
      label={t("visual.blockKinds.comment")}
      description={t("visual.commentHelp")}
      rows={Math.min(8, Math.max(2, block.text.split("\n").length))}
      value={block.text}
      onChange={(text) => onChange({ ...block, text })}
      isReadOnly={isReadOnly}
    />
  );
}

export function DirectiveFields({
  block,
  onChange,
  options,
  isReadOnly,
}: FieldsProps<Extract<SeclangBlock, { kind: "directive" }>>) {
  const t = useTranslations("seclang");
  const describe = useTermDescription();
  const name = canonicalTerm("directives", block.name) ?? block.name;
  const fixed = DIRECTIVE_VALUES[block.name.toLowerCase()];
  const description = describe("directives", name);
  // What the directive policy sends as written; anything else it flags or refuses.
  const status = !description
    ? "unknown"
    : ALLOWED_SECLANG_DIRECTIVES.has(name) || ALLOWED_SETTING_DIRECTIVES.has(name)
      ? "allowed"
      : "risky";
  return (
    <VStack
      gap={2}
      data-color={status === "allowed" ? "green" : status === "risky" ? "orange" : "yellow"}
      className="cpm-seclang-row"
    >
      <HStack gap={2} vAlign="end" wrap="wrap">
        <Selector
          label={t("kinds.directives")}
          hasSearch
          width={280}
          options={withCurrent(options.directives, name, t("visual.unknownTerm"))}
          value={name}
          onChange={(next) => onChange({ ...block, name: next })}
          isReadOnly={isReadOnly}
        />
        {fixed ? (
          <Selector
            label={t("kinds.values")}
            width={200}
            options={withCurrent(valueOptions(fixed), block.argument, t("visual.unknownTerm"))}
            value={block.argument || undefined}
            onChange={(argument) => onChange({ ...block, argument })}
            isReadOnly={isReadOnly}
          />
        ) : (
          <TextInput
            {...NO_SPELLCHECK}
            label={t("kinds.values")}
            width={320}
            value={block.argument}
            onChange={(argument) => onChange({ ...block, argument })}
            isReadOnly={isReadOnly}
          />
        )}
      </HStack>
      <Explanation
        color={status === "allowed" ? "green" : status === "risky" ? "orange" : "yellow"}
        tag={status === "unknown" ? t("unrecognised") : t(`directiveStatus.${status}`)}
        text={description ?? t("visual.unknownTerm")}
      />
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// Row ids
// ---------------------------------------------------------------------------

function tagCondition(condition: SeclangCondition): WithRowId<SeclangCondition> {
  return withRowId({
    ...condition,
    variables: condition.variables.map((v) => withRowId(v)),
    actions: condition.actions.map((a) => withRowId(a)),
  });
}

/** Gives every list item an id, so a row keeps its fields and focus as the lists change. */
export function tagBlock(block: SeclangBlock): SeclangBlock {
  switch (block.kind) {
    case "rule":
      return { ...block, conditions: block.conditions.map(tagCondition) };
    case "action":
    case "defaultAction":
      return { ...block, actions: block.actions.map((a) => withRowId(a)) };
    default:
      return block;
  }
}
