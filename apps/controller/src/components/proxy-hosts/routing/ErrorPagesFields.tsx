"use client";

import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Card } from "@astryxdesign/core/Card";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { ErrorPageRule } from "@/lib/models/proxy-hosts";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { useTranslations } from "next-intl";

type RuleState = { statuses: string; body: string; contentType: string };

function toState(rules: ErrorPageRule[]): WithRowId<RuleState>[] {
  return withRowIds(
    rules.map((r) => ({
      statuses: r.statuses.join(", "),
      body: r.body,
      contentType: r.contentType ?? "",
    })),
  );
}

function parseStatuses(value: string): number[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => parseInt(part.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 400 && n <= 599),
    ),
  ];
}

function toJson(rules: RuleState[]): string {
  return JSON.stringify(
    rules
      .filter((r) => r.body.trim())
      .map((r) => {
        const out: ErrorPageRule = { statuses: parseStatuses(r.statuses), body: r.body };
        if (r.contentType.trim()) out.contentType = r.contentType.trim();
        return out;
      }),
  );
}

type Props = {
  initialData?: ErrorPageRule[];
  // Lets one editor back the per-host and global settings forms.
  name?: string;
};

export function ErrorPagesFields({ initialData = [], name = "errorPagesJson" }: Props) {
  const t = useTranslations("proxyHosts");
  const [rules, setRules] = useState<WithRowId<RuleState>[]>(() => toState(initialData));

  const addRule = () =>
    setRules((r) => [
      ...r,
      withRowId({
        statuses: "502, 503, 504",
        // Raw: the body is HTML, and formatting would read its tags as rich-text markup.
        body: t.raw("errorPageDefaultBody") as string,
        contentType: "",
      }),
    ]);

  const removeRule = (rowId: string) => setRules((r) => r.filter((rule) => rule.rowId !== rowId));
  const updateRule = (rowId: string, key: keyof RuleState, value: string) =>
    setRules((r) => r.map((rule) => (rule.rowId === rowId ? { ...rule, [key]: value } : rule)));

  return (
    <VStack gap={2}>
      <Text type="body" size="sm" weight="semibold">
        {t("errorPages")}
      </Text>
      <input type="hidden" name={name} value={toJson(rules)} />

      {rules.length > 0 && (
        <VStack gap={3}>
          {rules.map((rule, i) => (
            <Card key={rule.rowId}>
              <VStack gap={2}>
                <HStack gap={2} vAlign="end">
                  <TextInput
                    label={t("statusCodes")}
                    size="sm"
                    placeholder={t("errorPageStatusCodesPlaceholder")}
                    value={rule.statuses}
                    onChange={(next) => updateRule(rule.rowId, "statuses", next)}
                  />
                  <TextInput
                    label={t("contentType")}
                    isOptional
                    size="sm"
                    placeholder={t("errorPageContentTypePlaceholder")}
                    value={rule.contentType}
                    onChange={(next) => updateRule(rule.rowId, "contentType", next)}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    label={t("removeErrorPageLabel", { index: i + 1 })}
                    icon={<Trash2 />}
                    onClick={() => removeRule(rule.rowId)}
                  />
                </HStack>
                {/* Styled HTML is unreadable in a three-row textarea. */}
                <CodeEditor
                  label={t("responseBody")}
                  language="html"
                  height="sm"
                  placeholder={t.raw("errorPageBodyPlaceholder") as string}
                  value={rule.body}
                  onChange={(next) => updateRule(rule.rowId, "body", next)}
                />
              </VStack>
            </Card>
          ))}
        </VStack>
      )}

      <HStack>
        <Button
          variant="ghost"
          size="sm"
          label={t("addErrorPage")}
          icon={<Plus />}
          onClick={addRule}
        />
      </HStack>

      <Text type="body" size="xsm" color="secondary">
        {t("errorPagesHelp")}
      </Text>
    </VStack>
  );
}
