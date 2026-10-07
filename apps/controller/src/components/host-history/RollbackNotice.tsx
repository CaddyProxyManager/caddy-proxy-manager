"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import type { MissingReference } from "@/lib/host-history/types";

export type EditorRollback = { revisionId: number; missing: MissingReference[] };

type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Inside the editor's form: says which revision it holds and what was left out of it, and carries
 * the revision so the save is recorded as rolling back to it.
 */
export function RollbackNotice({
  rollback,
  formId,
}: {
  rollback: EditorRollback;
  /** For a notice rendered beside the form rather than in it. */
  formId?: string;
}) {
  const t = useTranslations("hostHistory");
  const references = useTranslations("hostHistory.references") as unknown as DynamicTranslate;
  return (
    <VStack gap={3} data-testid="rollback-notice">
      <input type="hidden" name="rollbackRevision" value={rollback.revisionId} form={formId} />
      <Banner
        status={rollback.missing.length > 0 ? "warning" : "info"}
        title={t("rollbackBannerTitle", { id: rollback.revisionId })}
        description={t("rollbackBannerDescription")}
      />
      {rollback.missing.length > 0 && (
        <VStack gap={2}>
          <Text>{t("rollbackMissing")}</Text>
          <List density="compact">
            {rollback.missing.map((ref) => (
              <ListItem
                key={`${ref.kind}-${ref.id}`}
                label={references(ref.kind, { id: ref.id })}
              />
            ))}
          </List>
        </VStack>
      )}
    </VStack>
  );
}
