"use client";

/** Anything `sectionHealth` shows broken is lifted to the top: "is anything wrong" comes first. */

import Link from "next/link";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { ACCENTS, type Hue } from "@/components/ui/accent";
import { CARD_TITLE_STYLE } from "@/components/ui/card-title";
import type { SectionHealth } from "@/src/lib/settings/health";
import { SETTINGS_GROUPS, SETTINGS_HUES, settingsGroupLabel, settingsHref } from "./sections";
import type { StagedView } from "@/src/lib/settings/staged-view";
import SettingsFrame from "./SettingsFrame";

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

const STATUS_TOKEN: Record<SectionHealth["status"], { color: string; labelKey: StatusLabelKey }> = {
  ok: { color: "var(--color-success)", labelKey: "homeStatusHealthy" },
  attention: { color: "var(--color-warning)", labelKey: "homeStatusAttention" },
  unset: { color: "var(--color-border-emphasized)", labelKey: "homeStatusUnset" },
  env: { color: "var(--color-border-emphasized)", labelKey: "homeStatusEnv" },
};

function StatusDot({ status }: { status: SectionHealth["status"] }) {
  const t = useTranslations("settings");
  const token = STATUS_TOKEN[status];
  return (
    <span
      role="img"
      aria-label={t(token.labelKey)}
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: token.color,
        flexShrink: 0,
      }}
    />
  );
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
        {attention.length > 0 && (
          <Card padding={0}>
            <VStack gap={0}>
              <div
                style={{
                  padding: "var(--spacing-3) var(--spacing-4)",
                  background: "var(--color-warning-muted)",
                  borderTopLeftRadius: "var(--radius-container)",
                  borderTopRightRadius: "var(--radius-container)",
                }}
              >
                <HStack gap={2} vAlign="center">
                  <Text type="label">{t("homeAttentionTitle")}</Text>
                  <Text type="supporting" color="secondary">
                    {t("homeAttentionCount", { count: attention.length })}
                  </Text>
                </HStack>
              </div>
              {attention.map((section, index) => (
                <VStack key={section.id} gap={0}>
                  {index > 0 && <Divider />}
                  <div style={{ padding: "var(--spacing-3) var(--spacing-4)" }}>
                    <HStack gap={3} vAlign="center">
                      <VStack gap={0} style={{ flexGrow: 1, minWidth: 0 }}>
                        <Text type="label">{section.value}</Text>
                        <Text type="supporting" color="secondary">
                          {section.detail}
                        </Text>
                      </VStack>
                      <Link href={settingsHref(section.id)} style={{ flexShrink: 0 }}>
                        <Text type="body" color="accent">
                          {t("homeConfigure")}
                        </Text>
                      </Link>
                    </HStack>
                  </div>
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
                <div style={{ flexGrow: 1 }}>
                  <Divider />
                </div>
              </HStack>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                  gap: "var(--spacing-3)",
                }}
              >
                {tiles.map(({ section, hue }) => (
                  <SectionTile key={section.id} section={section} hue={hue} />
                ))}
              </div>
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
    <Link
      href={settingsHref(section.id)}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
      data-testid={`settings-tile-${section.id}`}
      data-status={section.status}
    >
      <Card padding={3} height="100%" className={ACCENTS[hue].edge}>
        <VStack gap={2}>
          <HStack gap={2} vAlign="center">
            <Text type="body" style={{ ...CARD_TITLE_STYLE, flexGrow: 1, minWidth: 0 }}>
              {section.name}
            </Text>
            {section.staged && <Badge variant="warning" label={t("homeStagedBadge")} />}
            {section.status === "env" && <Badge variant="neutral" label={t("homeEnvBadge")} />}
            {!section.staged && section.status !== "env" && <StatusDot status={section.status} />}
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
      </Card>
    </Link>
  );
}
