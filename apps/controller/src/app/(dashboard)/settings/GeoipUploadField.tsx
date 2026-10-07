"use client";

import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { GEOIP_EDITIONS, type GeoipEdition } from "@cpm/shared";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { StatusAlert } from "@/src/components/ui/FormLayout";

/**
 * A MaxMind database from disk rather than from MaxMind, for a deployment offline mode keeps off
 * the internet. Posted on its own, never with the GeoIP form it sits in: it is not staged.
 */
export function GeoipUploadField() {
  const t = useTranslations("settings.geoipUpload");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [edition, setEdition] = useState<GeoipEdition>("GeoLite2-Country");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const upload = () => {
    if (!file) return;
    setResult(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("edition", edition);
      form.set("file", file);
      try {
        const response = await fetch("/api/geoip/upload", { method: "POST", body: form });
        const body = (await response.json()) as { build?: string; error?: string };
        if (response.ok && body.build) {
          setResult({ success: true, message: t("uploaded", { edition, build: body.build }) });
          setFile(null);
          router.refresh();
        } else {
          setResult({ success: false, message: body.error ?? tErrors("geoipUploadFailed") });
        }
      } catch {
        setResult({ success: false, message: tErrors("geoipUploadFailed") });
      }
    });
  };

  return (
    <VStack gap={2}>
      <Text size="sm" weight="semibold">
        {t("title")}
      </Text>
      <Text size="sm" color="secondary">
        {t("description")}
      </Text>
      {result && <StatusAlert message={result.message} success={result.success} />}
      <HStack gap={2} vAlign="end" wrap="wrap">
        <Selector
          label={t("edition")}
          options={GEOIP_EDITIONS.map((value) => ({ value, label: value }))}
          value={edition}
          onChange={(value) => setEdition(value as GeoipEdition)}
        />
        <FileInput
          label={t("file")}
          accept=".mmdb"
          value={file}
          onChange={(files) => setFile(Array.isArray(files) ? (files[0] ?? null) : files)}
          isDisabled={pending}
        />
        <Button
          variant="secondary"
          label={t("upload")}
          onClick={upload}
          isDisabled={!file || pending}
          isLoading={pending}
        />
      </HStack>
    </VStack>
  );
}
