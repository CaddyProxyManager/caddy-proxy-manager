"use client";

import { useState } from "react";
import { Plus, Route, Trash2 } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { PathRewriteRule } from "@/lib/models/proxy-hosts";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { useTranslations } from "next-intl";

type Props = { initialData?: PathRewriteRule[] };

export function PathRewritesFields({ initialData = [] }: Props) {
  const t = useTranslations("proxyHosts");
  const [rules, setRules] = useState<WithRowId<PathRewriteRule>[]>(() => withRowIds(initialData));

  const addRule = () => setRules((r) => [...r, withRowId({ from: "", to: "" })]);
  const removeRule = (rowId: string) => setRules((r) => r.filter((rule) => rule.rowId !== rowId));
  const updateRule = (rowId: string, key: keyof PathRewriteRule, value: string) =>
    setRules((r) => r.map((rule) => (rule.rowId === rowId ? { ...rule, [key]: value } : rule)));

  return (
    <VStack gap={2}>
      <Text type="body" size="sm" weight="semibold">
        {t("pathRewrites")}
      </Text>
      <input
        type="hidden"
        name="pathRewritesJson"
        value={JSON.stringify(rules.map(({ from, to }): PathRewriteRule => ({ from, to })))}
      />

      {rules.length > 0 && (
        <VStack gap={2}>
          {rules.map((rule, i) => (
            <HStack key={rule.rowId} gap={2} vAlign="end">
              <TextInput
                startIcon={Route}
                label={t("fromPath")}
                isLabelHidden={i > 0}
                size="sm"
                placeholder="/secretpath"
                value={rule.from}
                onChange={(next) => updateRule(rule.rowId, "from", next)}
              />
              <TextInput
                startIcon={Route}
                label={t("internalTargetUri")}
                isLabelHidden={i > 0}
                size="sm"
                placeholder="/dns-query"
                value={rule.to}
                onChange={(next) => updateRule(rule.rowId, "to", next)}
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t("removePathRewriteLabel", { index: i + 1 })}
                icon={<Trash2 />}
                onClick={() => removeRule(rule.rowId)}
              />
            </HStack>
          ))}
        </VStack>
      )}

      <HStack>
        <Button
          variant="ghost"
          size="sm"
          label={t("addPathRewrite")}
          icon={<Plus />}
          onClick={addRule}
        />
      </HStack>

      <Text type="body" size="xsm" color="secondary">
        {t("internalRewriteHelp")}
      </Text>
    </VStack>
  );
}
