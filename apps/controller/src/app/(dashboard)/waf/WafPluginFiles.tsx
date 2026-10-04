"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpCircle, ExternalLink, FileCode, Folder, Trash2 } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { TreeList } from "@astryxdesign/core/TreeList";
import { useTranslations } from "next-intl";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { useSeclangIssues } from "@/components/ui/seclang-issues";
import { Timestamp } from "@/components/ui/Timestamp";
import { retryCrsPluginAction, saveCrsPluginConfigAction } from "./actions";
import type { WafPluginRow } from "./WafPluginsPanel";

type FileKind = "config" | "before" | "after";

const KIND = /-(config|before|after)\.conf$/;

/** The order CRS loads them in, which the builder follows. */
const KIND_ORDER: readonly FileKind[] = ["config", "before", "after"];

/** A plugin predating recorded file names lists one per kind, named as CRS names them. */
function pluginFiles(plugin: WafPluginRow): { name: string; kind: FileKind }[] {
  const named = plugin.fileNames.flatMap((name) => {
    const kind = KIND.exec(name)?.[1] as FileKind | undefined;
    return kind ? [{ name, kind }] : [];
  });
  if (named.length > 0) {
    return named.toSorted(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
    );
  }
  const stored = {
    config: plugin.configRules,
    before: plugin.beforeRules,
    after: plugin.afterRules,
  };
  return KIND_ORDER.filter((kind) => kind === "config" || stored[kind].trim()).map((kind) => ({
    name: `${plugin.name}-${kind}.conf`,
    kind,
  }));
}

export function WafPluginFiles({
  plugin,
  update,
  onUninstall,
}: {
  plugin: WafPluginRow;
  /** Set once Check for updates found a newer release. */
  update: { version: string; isUpdating: boolean; onUpdate: () => void } | null;
  onUninstall: () => void;
}) {
  const t = useTranslations("waf");
  const router = useRouter();
  const files = pluginFiles(plugin);
  const [selected, setSelected] = useState(
    () => files.find((file) => file.kind === "config")?.name ?? files[0]?.name,
  );
  const upstreamConfig = plugin.configRules;
  const savedConfig = plugin.configOverride ?? upstreamConfig;
  const [config, setConfig] = useState(savedConfig);
  const configIssues = useSeclangIssues(config);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      const result = await retryCrsPluginAction(plugin.id, plugin.name);
      if (result.status === "error") toast.error(result.message);
      else toast.success(result.message);
      router.refresh();
    } finally {
      setRetrying(false);
    }
  };

  const file = files.find((candidate) => candidate.name === selected) ?? files[0];
  const inUse = plugin.usedGlobally || plugin.usedByDashboard || plugin.hostCount > 0;

  const save = async (next: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveCrsPluginConfigAction(plugin.id, next);
      if (result.status === "error") {
        setError(result.message ?? null);
        return;
      }
      toast.success(result.message);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const tree = [
    {
      id: "plugins",
      label: "plugins/",
      startContent: <Folder size={16} aria-hidden="true" />,
      isExpanded: true,
      children: files.map((entry) => ({
        id: entry.name,
        label: entry.name,
        startContent: <FileCode size={16} aria-hidden="true" />,
        endContent:
          entry.kind === "config" && plugin.configOverride !== null ? (
            <Token size="sm" color="blue" label={t("pluginConfigEdited")} />
          ) : undefined,
        isSelected: entry.name === file?.name,
        onClick: () => setSelected(entry.name),
      })),
    },
  ];

  const isConfig = file?.kind === "config";
  const configFile = files.find((entry) => entry.kind === "config");

  return (
    // One Layout: a nested one bleeds by its container's padding under the divider above.
    <Layout
      height="auto"
      padding={0}
      header={
        // Up here so the editor starts level with the tree.
        <LayoutHeader hasDivider label={plugin.name}>
          <VStack gap={0}>
            <HStack gap={3} justify="between" vAlign="center" wrap="wrap" padding={3}>
              <VStack gap={0}>
                <Text type="body" size="base" weight="semibold">
                  {plugin.description ?? plugin.name}
                </Text>
                <Text type="body" size="sm" color="secondary">
                  {t("pluginSummary", {
                    start: plugin.ruleIdStart,
                    end: plugin.ruleIdEnd,
                    configFile: configFile?.name ?? `${plugin.name}-config.conf`,
                  })}
                </Text>
              </VStack>
              <HStack gap={2} wrap="wrap">
                {update && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<ArrowUpCircle />}
                    label={t("pluginUpdateTo", { version: update.version })}
                    isLoading={update.isUpdating}
                    onClick={update.onUpdate}
                  />
                )}
                <Button
                  size="sm"
                  icon={<ExternalLink />}
                  label={t("pluginSource")}
                  onClick={() => window.open(plugin.repository, "_blank", "noopener,noreferrer")}
                />
                <Button
                  size="sm"
                  variant="destructive"
                  icon={<Trash2 />}
                  label={t("pluginUninstall")}
                  onClick={onUninstall}
                />
              </HStack>
            </HStack>
            {plugin.loadFailedAt && (
              <VStack gap={2} paddingInline={3} paddingBlockEnd={3}>
                <Banner
                  status="error"
                  title={t("pluginDisabledTitle")}
                  description={t("pluginDisabledDescription")}
                  endContent={
                    <HStack gap={2} vAlign="center">
                      <Text type="body" size="xsm" color="secondary">
                        <Timestamp value={plugin.loadFailedAt} />
                      </Text>
                      <Button
                        size="sm"
                        label={t("pluginRetry")}
                        isLoading={retrying}
                        onClick={() => void retry()}
                      />
                    </HStack>
                  }
                />
              </VStack>
            )}
            {isConfig && (error || inUse) && (
              <VStack gap={2} paddingInline={3} paddingBlockEnd={3}>
                {error && <Banner status="error" title={error} />}
                {inUse && <Banner status="info" title={t("pluginConfigAppliesEverywhere")} />}
              </VStack>
            )}
          </VStack>
        </LayoutHeader>
      }
      start={
        <LayoutPanel width={320} hasDivider padding={3} label={t("pluginFiles")}>
          <TreeList items={tree} density="compact" />
        </LayoutPanel>
      }
      content={
        <LayoutContent padding={0}>
          {file && (
            <CodeEditor
              label={file.name}
              isLabelHidden
              isFlush
              isFooterHidden
              language="seclang"
              height="md"
              value={
                isConfig ? config : file.kind === "before" ? plugin.beforeRules : plugin.afterRules
              }
              onChange={isConfig ? setConfig : undefined}
              isReadOnly={!isConfig}
              isCopyable={!isConfig}
              issues={isConfig ? configIssues : undefined}
              overlay={
                isConfig && (
                  <HStack gap={2}>
                    {config !== upstreamConfig && (
                      <Button
                        size="sm"
                        label={t("pluginConfigRestore")}
                        onClick={() => setConfig(upstreamConfig)}
                      />
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      label={t("save")}
                      isLoading={saving}
                      isDisabled={config === savedConfig}
                      onClick={() => void save(config)}
                    />
                  </HStack>
                )
              }
            />
          )}
        </LayoutContent>
      }
    />
  );
}
