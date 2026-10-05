"use client";

import { Link } from "lucide-react";
import { useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import type { HostAnubisConfig } from "@/lib/proxy-hosts/anubis";
import { Switch } from "@/src/components/ui/FormBooleanControls";

/** The fields stay mounted while off, so switching it off in the editor keeps the rest. */
export function AnubisFields({ anubis }: { anubis?: HostAnubisConfig | null }) {
  const t = useTranslations("proxyHosts");
  const [enabled, setEnabled] = useState(anubis?.enabled ?? false);
  const [upstream, setUpstream] = useState(anubis?.upstream ?? "");
  const [exemptPaths, setExemptPaths] = useState((anubis?.exemptPaths ?? []).join("\n"));

  return (
    <Card>
      <input type="hidden" name="anubisPresent" value="1" />
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("anubis")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("anubisDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableAnubis")}
            isLabelHidden
            htmlName="anubisEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>
        <TextInput
          startIcon={Link}
          {...NO_SPELLCHECK}
          label={t("anubisUpstream")}
          isRequired={enabled}
          htmlName="anubisUpstream"
          placeholder="http://anubis:8923"
          value={upstream}
          onChange={setUpstream}
          description={t("anubisUpstreamHelp")}
        />
        <TextArea
          {...NO_SPELLCHECK}
          label={t("anubisExemptPaths")}
          isOptional
          htmlName="anubisExemptPaths"
          placeholder={"/api/*\n/.well-known/*"}
          value={exemptPaths}
          onChange={setExemptPaths}
          rows={3}
          description={t("anubisExemptPathsHelp")}
        />
      </VStack>
    </Card>
  );
}
