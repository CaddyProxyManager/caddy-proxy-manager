"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Plus, ShieldOff } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Timestamp } from "@/components/ui/Timestamp";
import { useEmptyValue } from "@/components/ui/empty-value";
import {
  ExclusionDialog,
  type ExclusionDraft,
  type HostOption,
} from "@/components/security/ExclusionDialog";
import type { WafExclusion } from "@/src/lib/models/waf-exclusions";
import { deleteWafExclusionAction } from "./actions";

const NEW_EXCLUSION: ExclusionDraft = {
  ruleId: null,
  proxyHostId: null,
  path: "",
  target: "",
  reason: "",
};

export function WafExclusionsPanel({
  exclusions,
  hosts,
  ruleMessages,
  wafEnabled,
}: {
  exclusions: WafExclusion[];
  hosts: HostOption[];
  ruleMessages: Record<number, string | null>;
  wafEnabled: boolean;
}) {
  const t = useTranslations("waf");
  const tCommon = useTranslations("common");
  const tProxyHosts = useTranslations("proxyHosts");
  const emptyValue = useEmptyValue();
  const router = useRouter();
  const [editing, setEditing] = useState<ExclusionDraft | null>(null);
  const [deleting, setDeleting] = useState<WafExclusion | null>(null);

  const columns: Column<WafExclusion>[] = [
    {
      id: "rule",
      label: tProxyHosts("ruleId"),
      render: (row) => (
        <VStack gap={0}>
          <Text type="code" size="sm" weight="semibold">
            {row.ruleId}
          </Text>
          <Text type="body" size="xsm" color="secondary" maxLines={1}>
            {ruleMessages[row.ruleId] ?? t("noRuleDescription")}
          </Text>
        </VStack>
      ),
    },
    {
      id: "scope",
      label: t("exclusionScope"),
      render: (row) =>
        row.proxyHostId === null ? (
          <Badge label={t("exclusionAllHosts")} />
        ) : (
          <Text type="body" size="sm">
            {row.hostName ?? emptyValue}
          </Text>
        ),
    },
    {
      id: "where",
      label: t("exclusionWhere"),
      render: (row) =>
        row.path || row.target ? (
          <VStack gap={0}>
            {row.path && (
              <Text type="code" size="xsm">
                {row.path}
              </Text>
            )}
            {row.target && (
              <Text type="code" size="xsm" color="secondary">
                {row.target}
              </Text>
            )}
          </VStack>
        ) : (
          <Text type="body" size="xsm" color="secondary">
            {t("exclusionEverywhere")}
          </Text>
        ),
    },
    {
      id: "reason",
      label: tCommon("reason"),
      render: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" maxLines={2}>
            {row.reason || emptyValue}
          </Text>
          <Text type="body" size="xsm" color="secondary">
            {row.createdBy ? t("exclusionBy", { name: row.createdBy }) : t("exclusionMigrated")}
          </Text>
          <Text type="body" size="xsm" color="secondary">
            <Timestamp value={row.updatedAt} />
          </Text>
        </VStack>
      ),
    },
    {
      id: "actions",
      label: tCommon("actions"),
      width: 64,
      align: "right",
      render: (row) => (
        <DropdownMenu
          hasChevron={false}
          alignment="end"
          button={{
            variant: "ghost",
            icon: <MoreHorizontal />,
            label: t("exclusionActions", { id: String(row.ruleId) }),
            isIconOnly: true,
          }}
          items={[
            {
              id: "edit",
              label: tCommon("edit"),
              onClick: () =>
                setEditing({
                  id: row.id,
                  ruleId: row.ruleId,
                  proxyHostId: row.proxyHostId,
                  path: row.path ?? "",
                  target: row.target ?? "",
                  reason: row.reason,
                }),
            },
            { id: "delete", label: t("exclusionDelete"), onClick: () => setDeleting(row) },
          ]}
        />
      ),
    },
  ];

  return (
    <VStack gap={6}>
      <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
        <VStack gap={1}>
          <Heading level={2}>{t("exclusions")}</Heading>
          <Text type="body" size="sm" color="secondary">
            {t("exclusionsDescription")}
          </Text>
        </VStack>
        <Button
          variant="primary"
          icon={<Plus />}
          label={t("exclusionNew")}
          onClick={() => setEditing(NEW_EXCLUSION)}
        />
      </HStack>
      {!wafEnabled && (
        <Banner
          status="warning"
          title={t("exclusionsDisabledTitle")}
          description={t("exclusionsDisabledDescription")}
        />
      )}

      {exclusions.length === 0 ? (
        <EmptyState
          icon={<ShieldOff />}
          title={t("exclusionsEmptyTitle")}
          description={t("exclusionsEmptyDescription")}
        />
      ) : (
        <DataTable columns={columns} data={exclusions} keyField="id" />
      )}

      <ExclusionDialog
        draft={editing}
        hosts={hosts}
        onClose={() => setEditing(null)}
        onSaved={(message) => {
          setEditing(null);
          toast.success(message);
          router.refresh();
        }}
      />

      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("exclusionDelete")}
        description={deleting ? t("exclusionDeleteConfirm", { id: String(deleting.ruleId) }) : ""}
        actionLabel={t("exclusionDelete")}
        onAction={async () => {
          if (!deleting) return;
          const result = await deleteWafExclusionAction(deleting.id);
          setDeleting(null);
          if (result.status === "error") {
            toast.error(result.message);
            return;
          }
          toast.success(result.message);
          router.refresh();
        }}
      />
    </VStack>
  );
}
