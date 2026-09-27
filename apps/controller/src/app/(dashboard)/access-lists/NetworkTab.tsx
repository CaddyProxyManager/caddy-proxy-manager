"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { AccessList } from "@/lib/models/access-lists";
import { withRowId, withRowIds, type WithRowId } from "@/lib/row-id";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { setAccessListIpRulesAction, updateAccessListAction } from "./actions";

type Rule = { action: "allow" | "deny"; cidr: string; note: string };

function toRules(list: AccessList): WithRowId<Rule>[] {
  return withRowIds(list.ipRules.map((rule) => ({ ...rule, note: rule.note ?? "" })));
}

/**
 * The list's IP rules, checked top to bottom: the first one matching the client decides. Saved as
 * a whole, since the order is the meaning.
 */
export function NetworkTab({
  list,
  onListUpdated,
}: {
  list: AccessList;
  onListUpdated: (list: AccessList) => void;
}) {
  const t = useTranslations("accessLists");
  const [rules, setRules] = useState(() => toRules(list));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different list resets the editor
  useEffect(() => {
    setRules(toRules(list));
    setError(null);
  }, [list.id, list.updatedAt]);

  const actionOptions = [
    { value: "allow", label: t("ipAllow") },
    { value: "deny", label: t("ipDeny") },
  ];

  const patch = (rowId: string, change: Partial<Rule>) =>
    setRules((current) =>
      current.map((rule) => (rule.rowId === rowId ? { ...rule, ...change } : rule)),
    );

  const move = (index: number, by: -1 | 1) =>
    setRules((current) => {
      const next = [...current];
      const [rule] = next.splice(index, 1);
      next.splice(index + by, 0, rule);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await setAccessListIpRulesAction(
        list.id,
        rules
          .filter((rule) => rule.cidr.trim())
          .map(({ action, cidr, note }) => ({
            action,
            cidr: cidr.trim(),
            note: note.trim() || null,
          })),
      );
      onListUpdated(updated);
      toast.success(t("saved"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ipRulesSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const saveDefault = async (value: string) => {
    try {
      onListUpdated(await updateAccessListAction(list.id, { ipDefault: value }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ipRulesSaveFailed"));
    }
  };

  const savedRules = JSON.stringify(
    list.ipRules.map(({ action, cidr, note }) => [action, cidr, note ?? ""]),
  );
  const editedRules = JSON.stringify(
    rules.map(({ action, cidr, note }) => [action, cidr.trim(), note.trim()]),
  );
  const dirty = savedRules !== editedRules;

  return (
    <VStack gap={4} maxWidth={720}>
      <Text type="body" size="sm" color="secondary">
        {t("ipRulesHelp")}
      </Text>
      {error && <Banner status="error" title={t("ipRulesSaveFailed")} description={error} />}

      {rules.length > 0 && (
        <VStack gap={2}>
          {rules.map((rule, index) => (
            <HStack key={rule.rowId} gap={2} vAlign="end" wrap="wrap">
              <Selector
                label={t("ipAction")}
                isLabelHidden={index > 0}
                size="sm"
                width={110}
                options={actionOptions}
                value={rule.action}
                onChange={(next) => patch(rule.rowId, { action: next as Rule["action"] })}
              />
              <TextInput
                {...NO_SPELLCHECK}
                label={t("ipCidr")}
                isLabelHidden={index > 0}
                size="sm"
                placeholder="192.168.1.0/24"
                value={rule.cidr}
                onChange={(next) => patch(rule.rowId, { cidr: next })}
              />
              <TextInput
                label={t("ipNote")}
                isLabelHidden={index > 0}
                size="sm"
                value={rule.note}
                onChange={(next) => patch(rule.rowId, { note: next })}
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t("ipMoveUp", { index: index + 1 })}
                icon={<ArrowUp />}
                isDisabled={index === 0}
                onClick={() => move(index, -1)}
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t("ipMoveDown", { index: index + 1 })}
                icon={<ArrowDown />}
                isDisabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t("ipRemove", { index: index + 1 })}
                icon={<Trash2 />}
                onClick={() => setRules((current) => current.filter((r) => r.rowId !== rule.rowId))}
              />
            </HStack>
          ))}
        </VStack>
      )}

      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus />}
          label={t("ipAddRule")}
          onClick={() =>
            setRules((current) => [...current, withRowId({ action: "allow", cidr: "", note: "" })])
          }
        />
        <Button
          size="sm"
          label={t("saveChanges")}
          onClick={save}
          isLoading={saving}
          isDisabled={!dirty || saving}
        />
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            label={t("discard")}
            onClick={() => setRules(toRules(list))}
          />
        )}
      </HStack>

      <Selector
        label={t("ipDefault")}
        description={t("ipDefaultHelp")}
        size="sm"
        width={320}
        options={[
          { value: "deny", label: t("ipDefaultDeny") },
          { value: "allow", label: t("ipDefaultAllow") },
        ]}
        value={list.ipDefault}
        onChange={(next) => saveDefault(next as string)}
      />
    </VStack>
  );
}
