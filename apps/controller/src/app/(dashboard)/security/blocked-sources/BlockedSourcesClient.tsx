"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Ban, Plus, Trash2 } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { CountryFlag } from "@/components/ui/CountryFlag";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Timestamp } from "@/components/ui/Timestamp";
import { useEmptyValue } from "@/components/ui/empty-value";
import { BlockSourceDialog, type BlockDraft } from "@/components/security/BlockSourceDialog";
import type { BlockedSource } from "@/src/lib/blocked-sources/types";
import { unblockSourceAction } from "../actions";

const NEW_BLOCK: BlockDraft = { kind: "ip", value: "", reason: "" };

export default function BlockedSourcesClient({
  sources,
  geoUsable,
}: {
  sources: BlockedSource[];
  /** Whether country, continent and network entries can be enforced. */
  geoUsable: boolean;
}) {
  const t = useTranslations("security");
  const tWaf = useTranslations("waf");
  const tCommon = useTranslations("common");
  const emptyValue = useEmptyValue();
  const router = useRouter();
  const [adding, setAdding] = useState<BlockDraft | null>(null);
  const [removing, setRemoving] = useState<BlockedSource | null>(null);
  const hasGeo = sources.some((source) => source.kind !== "ip" && source.kind !== "cidr");

  const columns: Column<BlockedSource>[] = [
    {
      id: "value",
      label: t("source"),
      render: (row) => (
        <HStack gap={2} vAlign="center" wrap="wrap">
          {row.kind === "country" ? (
            <CountryFlag code={row.value} showName />
          ) : (
            <Text type="code" size="sm" weight="semibold">
              {row.kind === "asn" ? `AS${row.value}` : row.value}
            </Text>
          )}
          <Badge label={t(`kinds.${row.kind}`)} />
        </HStack>
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
          {row.createdBy && (
            <Text type="body" size="sm" color="secondary">
              {tWaf("exclusionBy", { name: row.createdBy })}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      id: "expires",
      label: t("expiry"),
      width: 200,
      render: (row) =>
        row.expiresAt ? (
          <Text type="body" size="sm">
            <Timestamp value={row.expiresAt} />
          </Text>
        ) : (
          <Text type="body" size="sm" color="secondary">
            {t("neverExpires")}
          </Text>
        ),
    },
    {
      id: "actions",
      label: tCommon("actions"),
      width: 64,
      align: "right",
      render: (row) => (
        <IconButton
          variant="ghost"
          label={t("unblockValue", { value: row.value })}
          tooltip={t("unblock")}
          icon={<Trash2 />}
          onClick={() => setRemoving(row)}
        />
      ),
    },
  ];

  return (
    <VStack gap={6}>
      <HStack>
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft />}
          label={t("title")}
          href="/security"
        />
      </HStack>
      <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>{t("blockedSources")}</Heading>
          <Text type="body" size="sm" color="secondary">
            {t("blockedSourcesDescription")}
          </Text>
        </VStack>
        <Button
          variant="primary"
          icon={<Plus />}
          label={tCommon("add")}
          onClick={() => setAdding(NEW_BLOCK)}
        />
      </HStack>

      {hasGeo && !geoUsable && (
        <Banner
          status="warning"
          title={t("geoUnavailableTitle")}
          description={t("geoUnavailableDescription")}
        />
      )}

      {sources.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={<Ban />}
          title={t("blockedSourcesEmptyTitle")}
          description={t("blockedSourcesEmptyDescription")}
        />
      ) : (
        <DataTable columns={columns} data={sources} keyField="id" />
      )}

      <BlockSourceDialog
        draft={adding}
        onClose={() => setAdding(null)}
        onSaved={(message) => {
          setAdding(null);
          toast.success(message);
          router.refresh();
        }}
      />
      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("unblock")}
        description={removing ? t("unblockConfirm", { value: removing.value }) : ""}
        actionLabel={t("unblock")}
        onAction={async () => {
          if (!removing) return;
          const result = await unblockSourceAction(removing.id);
          setRemoving(null);
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
