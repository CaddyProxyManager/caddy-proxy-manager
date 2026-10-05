"use client";

/** Anything `sectionHealth` shows broken is lifted to the top: "is anything wrong" comes first. */

import Link from "next/link";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { ACCENTS, type Hue } from "@/components/ui/accent";
import { CARD_TITLE_CLASS } from "@/components/ui/card-title";
import type { SectionHealth } from "@/src/lib/settings/health";
import { SETTINGS_GROUPS, SETTINGS_HUES, settingsGroupLabel, settingsHref } from "./sections";
import type { StagedView } from "@/src/lib/settings/staged-view";
import SettingsFrame from "./SettingsFrame";
import { SettingsSearch } from "./SettingsSearch";

type Props = {
  sections: SectionHealth[];
  attention: SectionHealth[];
  staged: StagedView;
};

/** Colour alone is invisible to a screen reader, so each dot gets a catalog label. */
type StatusLabelKey =
  | "homeStatusHealthy"
  | "homeStatusAttention"
  | "homeStatusUnset"
  | "homeStatusEnv";

const STATUS_TOKEN: Record<
  SectionHealth["status"],
  { variant: "success" | "warning" | "neutral"; labelKey: StatusLabelKey }
> = {
  ok: { variant: "success", labelKey: "homeStatusHealthy" },
  attention: { variant: "warning", labelKey: "homeStatusAttention" },
  unset: { variant: "neutral", labelKey: "homeStatusUnset" },
  env: { variant: "neutral", labelKey: "homeStatusEnv" },
};

function SectionStatusDot({ status }: { status: SectionHealth["status"] }) {
  const t = useTranslations("settings");
  const token = STATUS_TOKEN[status];
  return <StatusDot variant={token.variant} label={t(token.labelKey)} />;
}

export default function SettingsHome({ sections, attention, staged }: Props) {
  const t = useTranslations("settings");

  // In the rail's order and groups, each tile in its section's colour.
  const byId = new Map(sections.map((section) => [section.id, section]));
  const groups = SETTINGS_GROUPS.map((group) => ({
    group,
    tiles: group.items.flatMap((item) =>
      item.blocks.flatMap((block) => {
        const section = byId.get(block.id);
        return section ? [{ section, hue: SETTINGS_HUES[item.id] ?? ("gray" as const) }] : [];
      }),
    ),
  }));

  // No page header here: the frame renders it, so the overview and every section share one.
  return (
    <SettingsFrame sectionId={null} staged={staged}>
      <VStack gap={5}>
        <SettingsSearch />
        {attention.length > 0 && (
          <Card padding={0}>
            <VStack gap={0}>
              <HStack
                gap={2}
                vAlign="center"
                paddingBlock={3}
                paddingInline={4}
                className="rounded-t-lg bg-warning-muted"
              >
                <Text type="label">{t("homeAttentionTitle")}</Text>
                <Text type="supporting" color="secondary">
                  {t("homeAttentionCount", { count: attention.length })}
                </Text>
              </HStack>
              {attention.map((section, index) => (
                <VStack key={section.id} gap={0}>
                  {index > 0 && <Divider />}
                  <HStack gap={3} vAlign="center" paddingBlock={3} paddingInline={4}>
                    <StackItem size="fill">
                      <VStack gap={0}>
                        <Text type="label">{section.value}</Text>
                        <Text type="supporting" color="secondary">
                          {section.detail}
                        </Text>
                      </VStack>
                    </StackItem>
                    <Link href={settingsHref(section.id)} className="shrink-0">
                      <Text type="body" color="accent">
                        {t("homeConfigure")}
                      </Text>
                    </Link>
                  </HStack>
                </VStack>
              ))}
            </VStack>
          </Card>
        )}

        {groups.map(({ group, tiles }) => {
          if (tiles.length === 0) return null;
          return (
            <VStack key={group.id} gap={3}>
              <HStack gap={3} vAlign="center">
                <Text type="label" size="sm" color="secondary">
                  {settingsGroupLabel(t, group)}
                </Text>
                <StackItem size="fill">
                  <Divider />
                </StackItem>
              </HStack>
              <Grid columns={{ minWidth: 240 }} gap={3}>
                {tiles.map(({ section, hue }) => (
                  <SectionTile key={section.id} section={section} hue={hue} />
                ))}
              </Grid>
            </VStack>
          );
        })}
      </VStack>
    </SettingsFrame>
  );
}

function SectionTile({ section, hue }: { section: SectionHealth; hue: Hue }) {
  const t = useTranslations("settings");
  return (
    <ClickableCard
      label={section.name}
      href={settingsHref(section.id)}
      padding={3}
      height="100%"
      className={ACCENTS[hue].edge}
      data-testid={`settings-tile-${section.id}`}
      data-status={section.status}
    >
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Text type="body" className={CARD_TITLE_CLASS}>
              {section.name}
            </Text>
          </StackItem>
          {section.staged && <Badge variant="warning" label={t("homeStagedBadge")} />}
          {section.status === "env" && <Badge variant="neutral" label={t("homeEnvBadge")} />}
          {!section.staged && section.status !== "env" && (
            <SectionStatusDot status={section.status} />
          )}
        </HStack>
        <Text type="body" color="secondary" maxLines={1}>
          {section.value}
        </Text>
        {section.detail && (
          <Text type="supporting" color="secondary" maxLines={2}>
            {section.detail}
          </Text>
        )}
      </VStack>
    </ClickableCard>
  );
}
