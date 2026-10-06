"use client";

import { useState } from "react";
import { Plus, Route, Trash2 } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { PathAllowRule } from "@/lib/models/proxy-hosts";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { useTranslations } from "next-intl";

type Props = { initialData?: PathAllowRule[] };

export function PathAllowsFields({ initialData = [] }: Props) {
  const t = useTranslations("proxyHosts");
  const [rules, setRules] = useState<WithRowId<PathAllowRule>[]>(() => withRowIds(initialData));

  const addRule = () => setRules((r) => [...r, withRowId({ path: "" })]);
  const removeRule = (rowId: string) => setRules((r) => r.filter((rule) => rule.rowId !== rowId));
  const updateRule = (rowId: string, value: string) =>
    setRules((r) => r.map((rule) => (rule.rowId === rowId ? { ...rule, path: value } : rule)));

  return (
    <VStack gap={2}>
      <Text type="body" size="sm" weight="semibold">
        {t("pathAllows")}
      </Text>
      <input
        type="hidden"
        name="pathAllowsJson"
        value={JSON.stringify(
          rules.filter((r) => r.path.trim()).map(({ path }): PathAllowRule => ({ path })),
        )}
      />

      {rules.length > 0 && (
        <VStack gap={2}>
          {rules.map((rule, i) => (
            <HStack key={rule.rowId} gap={2} vAlign="end">
              <TextInput
                startIcon={Route}
                label={t("pathLabel", { index: i + 1 })}
                isLabelHidden={i > 0}
                size="sm"
                placeholder="/secret"
                value={rule.path}
                onChange={(next) => updateRule(rule.rowId, next)}
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t("removePathAllowLabel", { index: i + 1 })}
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
          label={t("addPathAllow")}
          icon={<Plus />}
          onClick={addRule}
        />
      </HStack>

      <Text type="supporting">{t("pathAllowsHelp")}</Text>
    </VStack>
  );
}
