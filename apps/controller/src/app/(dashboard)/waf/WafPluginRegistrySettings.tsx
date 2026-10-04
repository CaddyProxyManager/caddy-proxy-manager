"use client";

import { useEffect, useState } from "react";
import { Clock, KeyRound, Link, Plus, Trash2 } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { IconButton } from "@astryxdesign/core/IconButton";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { CrsRegistrySettings } from "@/lib/crs-plugins/settings";
import { saveCrsRegistrySettingsAction } from "./actions";

// Repeated here rather than imported: the settings module pulls the server's secret handling in.
const OFFICIAL_URL =
  "https://raw.githubusercontent.com/coreruleset/plugin-registry/main/registry.json";
const MAX_INTERVAL_HOURS = 24 * 30;

type Draft = { key: string; id: string | null; name: string; url: string };

let nextKey = 0;
const draftKey = () => `registry-${nextKey++}`;

/** The registries read, how often, and the token that lifts GitHub's rate limit. */
export function WafPluginRegistrySettings({
  settings,
  isOpen,
  onClose,
  onSaved,
}: {
  settings: CrsRegistrySettings;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("waf");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [intervalHours, setIntervalHours] = useState<number | null>(settings.refreshIntervalHours);
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setDrafts(settings.registries.map((source) => ({ key: draftKey(), ...source })));
    setIntervalHours(settings.refreshIntervalHours);
    setToken("");
    setRemoveToken(false);
    setError(null);
  }, [isOpen, settings]);

  const update = (key: string, change: Partial<Draft>) =>
    setDrafts((prev) => prev.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveCrsRegistrySettingsAction({
        registries: drafts.map(({ id, name, url }) => ({ id, name, url })),
        refreshIntervalHours: intervalHours ?? 0,
        githubToken: removeToken ? "" : token.trim() || undefined,
      });
      if (result.status === "error") setError(result.message ?? null);
      else onSaved(result.message ?? "");
    } finally {
      setSaving(false);
    }
  };

  const hasOfficial = drafts.some((draft) => draft.url.trim() === OFFICIAL_URL);

  return (
    <AppDialog
      open={isOpen}
      onClose={onClose}
      title={t("pluginRegistrySettingsTitle")}
      maxWidth="lg"
      submitLabel={t("save")}
      isSubmitting={saving}
      isSubmitDisabled={drafts.some((draft) => !draft.name.trim() || !draft.url.trim())}
      onSubmit={() => void save()}
    >
      <VStack gap={4}>
        <Text type="body" size="sm" color="secondary">
          {t("pluginRegistrySettingsDescription")}
        </Text>
        {error && <Banner status="error" title={error} />}

        <VStack gap={3}>
          {drafts.length === 0 && (
            <Text type="body" size="sm" color="secondary">
              {t("pluginRegistryNone")}
            </Text>
          )}
          {drafts.map((draft) => (
            <HStack key={draft.key} gap={2} vAlign="end">
              <TextInput
                label={t("pluginRegistryName")}
                value={draft.name}
                onChange={(name) => update(draft.key, { name })}
                width={200}
              />
              <TextInput
                startIcon={Link}
                label={t("pluginRegistryUrl")}
                value={draft.url}
                onChange={(url) => update(draft.key, { url })}
                placeholder="https://"
                width="100%"
              />
              <IconButton
                variant="ghost"
                label={t("pluginRegistryRemove", { name: draft.name || draft.url })}
                icon={<Trash2 />}
                onClick={() => setDrafts((prev) => prev.filter((row) => row.key !== draft.key))}
              />
            </HStack>
          ))}
          <HStack gap={2} wrap="wrap">
            <Button
              size="sm"
              icon={<Plus />}
              label={t("pluginRegistryAdd")}
              onClick={() =>
                setDrafts((prev) => [...prev, { key: draftKey(), id: null, name: "", url: "" }])
              }
            />
            {!hasOfficial && (
              <Button
                size="sm"
                variant="ghost"
                label={t("pluginRegistryAddOfficial")}
                onClick={() =>
                  setDrafts((prev) => [
                    ...prev,
                    { key: draftKey(), id: null, name: "OWASP CRS", url: OFFICIAL_URL },
                  ])
                }
              />
            )}
          </HStack>
        </VStack>

        <Divider />

        <NumberInput
          startIcon={Clock}
          hasNumberSteppers
          units={t("pluginRegistryIntervalUnit")}
          label={t("pluginRegistryInterval")}
          description={t("pluginRegistryIntervalHelp")}
          value={intervalHours}
          onChange={setIntervalHours}
          min={0}
          max={MAX_INTERVAL_HOURS}
          step={1}
          isIntegerOnly
        />

        <VStack gap={2}>
          <TextInput
            startIcon={KeyRound}
            type="password"
            autoComplete="off"
            label={t("pluginRegistryToken")}
            description={t("pluginRegistryTokenHelp")}
            value={token}
            onChange={setToken}
            isDisabled={removeToken}
          />
          {settings.hasGithubToken && !removeToken && (
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="body" size="sm" color="secondary">
                {t("pluginRegistryTokenSet")}
              </Text>
              <Button
                size="sm"
                variant="ghost"
                label={t("pluginRegistryTokenRemove")}
                onClick={() => {
                  setRemoveToken(true);
                  setToken("");
                }}
              />
            </HStack>
          )}
        </VStack>
      </VStack>
    </AppDialog>
  );
}
