"use client";

import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { saveWafExclusionAction } from "@/src/app/(dashboard)/waf/actions";
import { PROTECTED_RULE_IDS } from "@/src/lib/waf/exclusions";

/** What the dialog edits; `id` set edits a stored exclusion, unset creates one. */
export type ExclusionDraft = {
  id?: number;
  ruleId: number | null;
  proxyHostId: number | null;
  path: string;
  target: string;
  reason: string;
};

export type HostOption = { id: number; name: string };

const ALL_HOSTS = "all";

export function ExclusionDialog({
  draft,
  hosts,
  onClose,
  onSaved,
}: {
  /** Null keeps it closed. */
  draft: ExclusionDraft | null;
  hosts: readonly HostOption[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("waf");
  const [ruleId, setRuleId] = useState<number | null>(null);
  const [scope, setScope] = useState(ALL_HOSTS);
  const [path, setPath] = useState("");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setRuleId(draft.ruleId);
    setScope(draft.proxyHostId === null ? ALL_HOSTS : String(draft.proxyHostId));
    setPath(draft.path);
    setTarget(draft.target);
    setReason(draft.reason);
    setError(null);
  }, [draft]);

  const isProtected = ruleId !== null && PROTECTED_RULE_IDS.includes(ruleId);

  async function submit() {
    if (ruleId === null) return;
    setSubmitting(true);
    setError(null);
    const result = await saveWafExclusionAction(draft?.id ?? null, {
      ruleId,
      proxyHostId: scope === ALL_HOSTS ? null : Number(scope),
      path: path.trim() || null,
      target: target.trim() || null,
      reason: reason.trim(),
    });
    setSubmitting(false);
    if (result.status === "error") {
      setError(result.message ?? t("exclusionSaveFailed"));
      return;
    }
    onSaved(result.message ?? "");
  }

  return (
    <AppDialog
      open={draft !== null}
      onClose={onClose}
      title={draft?.id ? t("exclusionEditTitle") : t("exclusionNewTitle")}
      maxWidth="md"
      submitLabel={t("exclusionSave")}
      onSubmit={submit}
      isSubmitting={submitting}
      isSubmitDisabled={ruleId === null || isProtected}
    >
      <VStack gap={4}>
        {error && <Banner status="error" title={error} />}
        <NumberInput
          label={t("ruleId")}
          value={ruleId}
          onChange={setRuleId}
          isIntegerOnly
          min={1}
          isRequired
          status={isProtected ? { type: "error", message: t("exclusionProtectedRule") } : undefined}
        />
        <Selector
          label={t("exclusionScope")}
          description={t("exclusionScopeHelp")}
          value={scope}
          onChange={(next) => setScope(next ?? ALL_HOSTS)}
          hasSearch={hosts.length > 8}
          options={[
            { value: ALL_HOSTS, label: t("exclusionAllHosts") },
            ...hosts.map((host) => ({ value: String(host.id), label: host.name })),
          ]}
        />
        <TextInput
          label={t("exclusionPath")}
          description={t("exclusionPathHelp")}
          placeholder="/api/upload"
          value={path}
          onChange={setPath}
          isOptional
        />
        <TextInput
          label={t("exclusionTarget")}
          description={t("exclusionTargetHelp")}
          placeholder="ARGS:content"
          value={target}
          onChange={setTarget}
          isOptional
        />
        <TextInput
          label={t("exclusionReason")}
          placeholder={t("exclusionReasonPlaceholder")}
          value={reason}
          onChange={setReason}
          isOptional
        />
      </VStack>
    </AppDialog>
  );
}
