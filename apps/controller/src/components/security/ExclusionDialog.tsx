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
import {
  DASHBOARD_EXCLUSION_HOST_ID,
  PROTECTED_RULE_IDS,
  normalizeExclusionClientIp,
} from "@/src/lib/waf/exclusions";

/** What the dialog edits; `id` set edits a stored exclusion, unset creates one. */
export type ExclusionDraft = {
  id?: number;
  ruleId: number | null;
  proxyHostId: number | null;
  path: string;
  target: string;
  clientIp: string;
  reason: string;
};

export type HostOption = { id: number; name: string };

const ALL_HOSTS = "all";

function isClientIpValid(value: string): boolean {
  try {
    normalizeExclusionClientIp(value);
    return true;
  } catch {
    return false;
  }
}
const DASHBOARD = "dashboard";

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
  const tCommon = useTranslations("common");
  const tProxyHosts = useTranslations("proxyHosts");
  const [ruleId, setRuleId] = useState<number | null>(null);
  const [scope, setScope] = useState(ALL_HOSTS);
  const [path, setPath] = useState("");
  const [target, setTarget] = useState("");
  const [clientIp, setClientIp] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setRuleId(draft.ruleId);
    setScope(
      draft.proxyHostId === null
        ? ALL_HOSTS
        : draft.proxyHostId === DASHBOARD_EXCLUSION_HOST_ID
          ? DASHBOARD
          : String(draft.proxyHostId),
    );
    setPath(draft.path);
    setTarget(draft.target);
    setClientIp(draft.clientIp);
    setReason(draft.reason);
    setError(null);
  }, [draft]);

  const isProtected = ruleId !== null && PROTECTED_RULE_IDS.includes(ruleId);
  const clientIpInvalid = !isClientIpValid(clientIp);

  async function submit() {
    if (ruleId === null) return;
    setSubmitting(true);
    setError(null);
    const result = await saveWafExclusionAction(draft?.id ?? null, {
      ruleId,
      proxyHostId:
        scope === ALL_HOSTS
          ? null
          : scope === DASHBOARD
            ? DASHBOARD_EXCLUSION_HOST_ID
            : Number(scope),
      path: path.trim() || null,
      target: target.trim() || null,
      clientIp: clientIp.trim() || null,
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
      submitLabel={tCommon("save")}
      onSubmit={submit}
      isSubmitting={submitting}
      isSubmitDisabled={ruleId === null || isProtected || clientIpInvalid}
    >
      <VStack gap={4}>
        {error && <Banner role="alert" status="error" title={error} />}
        <NumberInput
          label={tProxyHosts("ruleId")}
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
            { value: DASHBOARD, label: t("exclusionDashboard") },
            ...hosts.map((host) => ({ value: String(host.id), label: host.name })),
          ]}
        />
        <TextInput
          label={tProxyHosts("path")}
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
          label={t("exclusionClientIp")}
          description={t("exclusionClientIpHelp")}
          placeholder="203.0.113.0/24"
          value={clientIp}
          onChange={setClientIp}
          isOptional
          status={
            clientIpInvalid ? { type: "error", message: t("exclusionClientIpInvalid") } : undefined
          }
        />
        <TextInput
          label={tCommon("reason")}
          placeholder={t("exclusionReasonPlaceholder")}
          value={reason}
          onChange={setReason}
          isOptional
        />
      </VStack>
    </AppDialog>
  );
}
