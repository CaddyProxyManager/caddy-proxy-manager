"use client";

/**
 * Every settings screen's frame. The sticky header names the page, the live revision and the apply
 * control, which therefore never moves with the scroll.
 */

import type { ReactNode } from "react";
import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import type { StagedView } from "@/src/lib/settings/staged-view";
import {
  findSettingsItem,
  groupForSection,
  settingsGroupLabel,
  settingsSectionName,
} from "./sections";
import { RevisionPill, StagedControls } from "./StagedChanges";

/**
 * Capped and centred: full-width inputs sit a screen away from their labels. The header shares the
 * measure so the title sits over the cards.
 */
const COLUMN = 768;
const ASIDE = 176;

function Measure({ aside, children }: { aside: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: aside ? `calc(${COLUMN}px + ${ASIDE}px + var(--spacing-5))` : COLUMN,
        marginInline: "auto",
      }}
    >
      {children}
    </div>
  );
}

export default function SettingsFrame({
  sectionId,
  title,
  staged,
  aside = true,
  children,
}: {
  /** Null on the overview. */
  sectionId: string | null;
  /** For a page that is not a section, such as the history. */
  title?: string;
  staged: StagedView;
  /** A list of its blocks beside the column, which the measure allows for. */
  aside?: boolean;
  children: ReactNode;
}) {
  return (
    <VStack gap={0} height="fill">
      <SettingsHeader sectionId={sectionId} title={title} staged={staged} aside={aside} />
      {/* No overflow here: it would become the scrollport sticky measures against, and nothing
          inside (header, save bar) would pin. */}
      <div style={{ flexGrow: 1, padding: "var(--spacing-5)" }}>
        <Measure aside={aside}>{children}</Measure>
      </div>
    </VStack>
  );
}

function SettingsHeader({
  sectionId,
  title,
  staged,
  aside,
}: {
  sectionId: string | null;
  title?: string;
  staged: StagedView;
  aside: boolean;
}) {
  const t = useTranslations("settings");
  const tNav = useTranslations("nav");
  const item = sectionId ? findSettingsItem(sectionId) : undefined;
  const group = sectionId ? groupForSection(sectionId) : undefined;

  return (
    <div
      style={{
        flexShrink: 0,
        // Sticky, not fixed: it scrolls away where a narrow viewport cannot spare the room.
        position: "sticky",
        top: 0,
        zIndex: 4,
        background: "var(--color-background-body)",
        borderBottom: "1px solid var(--color-border)",
        padding: "var(--spacing-4) var(--spacing-5)",
      }}
      data-testid="settings-header"
    >
      <Measure aside={aside}>
        <HStack gap={4} vAlign="end" wrap="wrap">
          <VStack gap={1} style={{ flexGrow: 1, minWidth: 0 }}>
            <div data-testid="settings-breadcrumb">
              <Breadcrumbs>
                <BreadcrumbItem>{tNav("settings")}</BreadcrumbItem>
                {group ? (
                  <BreadcrumbItem isCurrent>{settingsGroupLabel(t, group)}</BreadcrumbItem>
                ) : (
                  <BreadcrumbItem isCurrent>{title ?? t("homeOverview")}</BreadcrumbItem>
                )}
              </Breadcrumbs>
            </div>
            {/* No env-var token here: it would claim to configure every block on the page. */}
            <Heading level={1}>
              {item ? settingsSectionName(t, item) : (title ?? t("homeOverview"))}
            </Heading>
          </VStack>

          <HStack gap={2} vAlign="center" style={{ flexShrink: 0 }}>
            <RevisionPill staged={staged} />
            <StagedControls view={staged} />
          </HStack>
        </HStack>
      </Measure>
    </div>
  );
}
