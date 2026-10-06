"use client";

import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { blockSourceAction } from "@/src/app/(dashboard)/security/actions";
import {
  BLOCK_EXPIRY_PRESETS,
  BLOCKED_SOURCE_KINDS,
  type BlockExpiryPreset,
  type BlockedSourceKind,
  expiryFromPreset,
} from "@/src/lib/blocked-sources/types";

export type BlockDraft = { kind: BlockedSourceKind; value: string; reason: string };

export function BlockSourceDialog({
  draft,
  onClose,
  onSaved,
}: {
  /** Null keeps it closed. */
  draft: BlockDraft | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("security");
  const tCommon = useTranslations("common");
  const [kind, setKind] = useState<BlockedSourceKind>("ip");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState<BlockExpiryPreset>("24h");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setKind(draft.kind);
    setValue(draft.value);
    setReason(draft.reason);
    setExpiry("24h");
    setError(null);
  }, [draft]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    const result = await blockSourceAction({
      kind,
      value,
      reason,
      expiresAt: expiryFromPreset(expiry, Date.now()),
    });
    setSubmitting(false);
    if (result.status === "error") {
      setError(result.message ?? t("blockFailed"));
      return;
    }
    onSaved(result.message ?? "");
  }

  return (
    <AppDialog
      open={draft !== null}
      onClose={onClose}
      title={t("blockTitle")}
      submitLabel={tCommon("block")}
      onSubmit={submit}
      isSubmitting={submitting}
      isSubmitDisabled={!value.trim()}
    >
      <VStack gap={4}>
        {error && <Banner status="error" title={error} />}
        <Selector
          label={t("sourceKind")}
          value={kind}
          onChange={(next) => setKind((next as BlockedSourceKind) ?? "ip")}
          options={BLOCKED_SOURCE_KINDS.map((option) => ({
            value: option,
            label: t(`kinds.${option}`),
          }))}
        />
        <TextInput
          label={t("sourceValue")}
          description={t(`valueHelp.${kind}`)}
          value={value}
          onChange={setValue}
          isRequired
        />
        <TextInput label={tCommon("reason")} value={reason} onChange={setReason} isOptional />
        <Selector
          label={t("expiry")}
          description={t("expiryHelp")}
          value={expiry}
          onChange={(next) => setExpiry((next as BlockExpiryPreset) ?? "24h")}
          options={BLOCK_EXPIRY_PRESETS.map((preset) => ({
            value: preset.id,
            label: t(`expiryPresets.${preset.labelKey}`),
          }))}
        />
      </VStack>
    </AppDialog>
  );
}
