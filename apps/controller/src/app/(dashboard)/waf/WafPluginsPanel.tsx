"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Settings } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { SearchField } from "@/components/ui/SearchField";
import { useEmptyValue } from "@/components/ui/empty-value";
import { Timestamp } from "@/components/ui/Timestamp";
import type { CrsRegistryListing } from "@/lib/models/crs-plugins";
import {
  type CrsRegistryOverview,
  checkCrsPluginUpdatesAction,
  checkCrsRegistryNowAction,
  installCrsPluginAction,
  listCrsRegistryAction,
  uninstallCrsPluginAction,
  updateCrsPluginAction,
} from "./actions";
import { WafPluginFiles } from "./WafPluginFiles";
import { WafPluginRegistrySettings } from "./WafPluginRegistrySettings";

export type WafPluginRow = {
  id: number;
  name: string;
  description: string | null;
  repository: string;
  version: string;
  ruleIdStart: number;
  ruleIdEnd: number;
  configRules: string;
  beforeRules: string;
  afterRules: string;
  configOverride: string | null;
  fileNames: string[];
  /** When Caddy refused to load the WAF with it and it was switched off; null while it loads. */
  loadFailedAt: string | null;
  updatedAt: string;
  usedGlobally: boolean;
  usedByDashboard: boolean;
  hostCount: number;
};

/** `key` tells apart two registries' plugins of the same name. */
type RegistryRow = CrsRegistryListing & { key: string };

const STATUS = {
  tested: { color: "green", key: "tested" },
  "being-tested": { color: "yellow", key: "beingTested" },
  untested: { color: "gray", key: "untested" },
  draft: { color: "gray", key: "draft" },
} as const;

/** A full commit sha reads as noise; a tag is kept as it is. */
function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}

export function WafPluginsPanel({
  plugins,
  storedUpdates,
}: {
  plugins: WafPluginRow[];
  /** Newer releases the last scheduled check found, by installed plugin id. */
  storedUpdates: Record<number, string>;
}) {
  const t = useTranslations("waf");
  const emptyValue = useEmptyValue();
  const router = useRouter();
  const [registry, setRegistry] = useState<CrsRegistryOverview | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkingRegistry, setCheckingRegistry] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Record<number, string> | null>(
    Object.keys(storedUpdates).length > 0 ? storedUpdates : null,
  );
  const [checking, setChecking] = useState(false);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [uninstalling, setUninstalling] = useState<WafPluginRow | null>(null);
  const [query, setQuery] = useState("");
  const registryRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      (registry?.entries ?? [])
        .filter((entry) => entry.name.toLowerCase().includes(needle))
        .map((entry) => ({ ...entry, key: `${entry.registryId}/${entry.name}` }))
        // The unsupported ones last: they are listed only so their absence is explained.
        .toSorted((a, b) => Number(!!a.unsupported) - Number(!!b.unsupported))
    );
  }, [registry, query]);

  const loadRegistry = useCallback(async () => {
    setRegistryError(null);
    const result = await listCrsRegistryAction();
    if (result.status === "error") setRegistryError(result.message);
    else setRegistry(result);
  }, []);

  const checkRegistryNow = async () => {
    setCheckingRegistry(true);
    try {
      const result = await checkCrsRegistryNowAction();
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      setRegistry(result);
      if (!result.error) {
        toast.success(t("pluginRegistryChecked", { count: result.entries.length }));
      }
    } finally {
      setCheckingRegistry(false);
    }
  };

  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry]);

  const install = async (row: RegistryRow) => {
    setInstalling(row.key);
    try {
      const result = await installCrsPluginAction(row.registryId, row.name);
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      router.refresh();
      await loadRegistry();
    } finally {
      setInstalling(null);
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const result = await checkCrsPluginUpdatesAction();
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      setUpdates(result.updates);
      if (Object.keys(result.updates).length === 0) toast.success(t("pluginsUpToDate"));
    } finally {
      setChecking(false);
    }
  };

  const update = async (row: WafPluginRow) => {
    setUpdatingId(row.id);
    try {
      const result = await updateCrsPluginAction(row.id);
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      setUpdates((prev) => {
        if (!prev) return prev;
        const { [row.id]: _done, ...rest } = prev;
        return rest;
      });
      router.refresh();
    } finally {
      setUpdatingId(null);
    }
  };

  const usageLabels = (row: WafPluginRow) => {
    const parts: string[] = [];
    if (row.usedGlobally) parts.push(t("presetUsedGlobally"));
    if (row.usedByDashboard) parts.push(t("presetUsedByDashboard"));
    if (row.hostCount > 0) parts.push(t("presetUsedByHosts", { count: row.hostCount }));
    return parts;
  };

  const installedColumns: Column<WafPluginRow>[] = [
    {
      id: "name",
      label: t("pluginName"),
      render: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold">
            {row.name}
          </Text>
          {row.description && (
            <Text type="body" size="xsm" color="secondary" maxLines={1}>
              {row.description}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      id: "version",
      label: t("pluginVersion"),
      width: 200,
      render: (row) => (
        <HStack gap={1} wrap="wrap">
          <Token size="sm" label={shortVersion(row.version)} />
          {row.loadFailedAt && (
            <Tooltip content={t("pluginDisabledTooltip")}>
              <Token size="sm" color="red" label={t("pluginDisabled")} />
            </Tooltip>
          )}
          {row.configOverride !== null && (
            <Token size="sm" color="blue" label={t("pluginConfigEdited")} />
          )}
          {updates?.[row.id] && (
            <Token
              size="sm"
              color="orange"
              label={t("pluginUpdateAvailable", { version: shortVersion(updates[row.id]) })}
            />
          )}
        </HStack>
      ),
    },
    {
      id: "usage",
      label: t("presetUsedBy"),
      width: 220,
      render: (row) => {
        const labels = usageLabels(row);
        return labels.length === 0 ? (
          <Text type="body" size="xsm" color="secondary">
            {t("pluginUnused")}
          </Text>
        ) : (
          <HStack gap={1} wrap="wrap">
            {labels.map((label) => (
              <Badge key={label} label={label} />
            ))}
          </HStack>
        );
      },
    },
  ];

  const registryColumns: Column<RegistryRow>[] = [
    {
      id: "name",
      label: t("pluginName"),
      render: (row) => (
        <Link
          href={row.repository}
          target="_blank"
          color={row.unsupported ? "secondary" : undefined}
        >
          {row.name}
        </Link>
      ),
    },
    {
      id: "registry",
      label: t("pluginRegistryColumn"),
      width: 160,
      render: (row) => (
        <Text type="body" size="xsm" color={row.unsupported ? "disabled" : "secondary"}>
          {row.registryName}
        </Text>
      ),
    },
    {
      id: "type",
      label: t("pluginType"),
      width: 140,
      render: (row) => (
        <Token
          size="sm"
          color={row.type === "official" ? "blue" : "default"}
          label={row.type === "official" ? t("pluginOfficial") : t("pluginThirdParty")}
          isDisabled={Boolean(row.unsupported)}
        />
      ),
    },
    {
      id: "status",
      label: t("pluginStatusColumn"),
      width: 140,
      render: (row) => (
        <Token
          size="sm"
          color={STATUS[row.status].color}
          label={t(`pluginStatus.${STATUS[row.status].key}`)}
          isDisabled={Boolean(row.unsupported)}
        />
      ),
    },
    {
      id: "license",
      label: t("pluginLicense"),
      width: 140,
      render: (row) => (
        <Text type="body" size="xsm" color={row.unsupported ? "disabled" : "secondary"}>
          {row.license || emptyValue}
        </Text>
      ),
    },
    {
      id: "range",
      label: t("pluginRuleIds"),
      width: 180,
      render: (row) => (
        <Text type="body" size="xsm" color={row.unsupported ? "disabled" : "secondary"}>
          {t("pluginRuleIdRange", { start: row.ruleIdStart, end: row.ruleIdEnd })}
        </Text>
      ),
    },
    {
      id: "install",
      label: t("actions"),
      width: 120,
      align: "right",
      render: (row) =>
        row.installedId !== null ? (
          // As tall as the Install button, so every row is the same height.
          <HStack minHeight="var(--size-element-sm)" vAlign="center" justify="end">
            <Token size="sm" color="green" label={t("pluginInstalledBadge")} />
          </HStack>
        ) : row.unsupported ? (
          <HStack minHeight="var(--size-element-sm)" vAlign="center" justify="end">
            <Tooltip content={t(`pluginUnsupportedReason.${row.unsupported}`)}>
              <Token size="sm" color="red" label={t("pluginUnsupported")} />
            </Tooltip>
          </HStack>
        ) : (
          <Button
            size="sm"
            label={t("pluginInstall")}
            isLoading={installing === row.key}
            isDisabled={installing !== null && installing !== row.key}
            onClick={() => void install(row)}
          />
        ),
    },
  ];

  return (
    // Two stacked cards need more air than the list pages' header and table.
    <VStack gap={10}>
      <Card>
        <VStack gap={4}>
          <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
            <VStack gap={1}>
              <Heading level={2}>{t("plugins")}</Heading>
              <Text type="body" size="sm" color="secondary">
                {t("pluginsDescription")}
              </Text>
            </VStack>
            {plugins.length > 0 && (
              <Button
                icon={<RefreshCw />}
                label={t("pluginsCheckUpdates")}
                isLoading={checking}
                onClick={() => void checkUpdates()}
              />
            )}
          </HStack>
          {plugins.length === 0 ? (
            <EmptyState title={t("pluginsEmptyTitle")} description={t("pluginsEmptyDescription")} />
          ) : (
            <DataTable
              columns={installedColumns}
              data={plugins}
              keyField="id"
              expandOnRowClick
              expandedRow={(row) => (
                <WafPluginFiles
                  plugin={row}
                  update={
                    updates?.[row.id]
                      ? {
                          version: shortVersion(updates[row.id]),
                          isUpdating: updatingId === row.id,
                          onUpdate: () => void update(row),
                        }
                      : null
                  }
                  onUninstall={() => setUninstalling(row)}
                />
              )}
            />
          )}
        </VStack>
      </Card>

      <Card>
        <VStack gap={4}>
          <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
            <VStack gap={1}>
              <Heading level={2}>{t("pluginRegistry")}</Heading>
              <Text type="body" size="sm" color="secondary">
                {t("pluginRegistryDescription")}
              </Text>
              {registry && (
                <Text type="body" size="xsm" color="secondary">
                  {registry.checkedAt
                    ? t.rich("pluginRegistryLastChecked", {
                        time: () => <Timestamp value={registry.checkedAt ?? ""} />,
                      })
                    : t("pluginRegistryNeverChecked")}
                </Text>
              )}
            </VStack>
            <HStack gap={2}>
              <Button
                icon={<RefreshCw />}
                label={t("pluginRegistryCheckNow")}
                isLoading={checkingRegistry}
                isDisabled={!registry}
                onClick={() => void checkRegistryNow()}
              />
              <IconButton
                label={t("pluginRegistrySettings")}
                tooltip={t("pluginRegistrySettings")}
                icon={<Settings />}
                isDisabled={!registry}
                onClick={() => setSettingsOpen(true)}
              />
            </HStack>
          </HStack>
          {registry?.error && (
            <Banner
              status="warning"
              title={t("pluginRegistryIncomplete", { error: registry.error })}
            />
          )}
          {registry?.sourceErrors.map((source) => (
            <Banner
              key={source.name}
              status="error"
              title={t("pluginRegistrySourceFailed", { name: source.name, error: source.message })}
            />
          ))}
          {registryError ? (
            <Banner
              status="error"
              title={registryError}
              endContent={
                <Button
                  size="sm"
                  label={t("pluginRegistryRetry")}
                  onClick={() => void loadRegistry()}
                />
              }
            />
          ) : registry === null ? (
            <Text type="body" size="sm" color="secondary">
              {t("pluginRegistryLoading")}
            </Text>
          ) : (
            <VStack gap={4}>
              <SearchField
                value={query}
                onChange={setQuery}
                label={t("pluginRegistrySearch")}
                placeholder={t("pluginRegistrySearchPlaceholder")}
                width="100%"
              />
              <DataTable
                columns={registryColumns}
                data={registryRows}
                keyField="key"
                emptyMessage={t("pluginRegistryNoMatches")}
              />
            </VStack>
          )}
        </VStack>
      </Card>

      {registry && (
        <WafPluginRegistrySettings
          settings={registry.settings}
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={(message) => {
            setSettingsOpen(false);
            toast.success(message);
            void loadRegistry();
          }}
        />
      )}

      <AlertDialog
        isOpen={uninstalling !== null}
        onOpenChange={(open) => !open && setUninstalling(null)}
        title={t("pluginUninstall")}
        description={uninstalling ? t("pluginUninstallConfirm", { name: uninstalling.name }) : ""}
        actionLabel={t("pluginUninstall")}
        onAction={async () => {
          if (!uninstalling) return;
          const result = await uninstallCrsPluginAction(uninstalling.id);
          setUninstalling(null);
          if (result.status === "error") {
            toast.error(result.message);
            return;
          }
          toast.success(result.message);
          router.refresh();
          await loadRegistry();
        }}
      />
    </VStack>
  );
}
