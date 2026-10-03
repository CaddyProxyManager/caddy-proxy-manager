"use client";

/** Settings takes over the rail rather than nesting a second; its first row is the only exit. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { VStack } from "@astryxdesign/core/Stack";
import { ArrowLeft, DatabaseBackup, History, LayoutGrid } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  SETTINGS_GROUPS,
  SETTINGS_HUES,
  settingsGroupLabel,
  settingsSectionName,
} from "./sections";
import { ACCENTS } from "@/src/components/ui/accent";
import { PaletteSearchButton } from "@/src/components/command-palette/GlobalCommandPalette";
import { storageKeysForSection } from "@/src/lib/settings/section-keys";

export default function SettingsSideNav({
  footer,
  stagedKeys,
}: {
  /** Reused from the dashboard rail so the two do not drift. */
  footer: ReactNode;
  /** Pending edits, so a section carrying one is marked. */
  stagedKeys: readonly string[];
}) {
  const t = useTranslations("settings");
  const tNav = useTranslations("nav");
  const pathname = usePathname();
  const staged = new Set(stagedKeys);

  return (
    <SideNav
      // History sits with the account controls, apart from the sections it records changes to.
      footer={
        <VStack gap={2}>
          <SideNavItem
            as={Link}
            href="/settings/history"
            label={t("history.navLabel")}
            icon={<History className={ACCENTS.orange.text} />}
            isSelected={pathname === "/settings/history"}
          />
          {footer}
        </VStack>
      }
      data-testid="settings-rail"
    >
      <VStack gap={2} padding={2}>
        <SideNavItem as={Link} href="/" label={t("backToDashboard")} icon={<ArrowLeft />} />
        <PaletteSearchButton />
      </VStack>

      <SideNavSection title={tNav("settings")} isHeaderHidden>
        <SideNavItem
          as={Link}
          href="/settings"
          label={t("homeOverview")}
          icon={<LayoutGrid className={ACCENTS.gray.text} />}
          isSelected={pathname === "/settings"}
        />
        <SideNavItem
          as={Link}
          href="/settings/backup"
          label={t("backup.navLabel")}
          icon={<DatabaseBackup className={ACCENTS.green.text} />}
          isSelected={pathname === "/settings/backup"}
        />
      </SideNavSection>

      {SETTINGS_GROUPS.map((group) => (
        <SideNavSection key={group.id} title={settingsGroupLabel(t, group)}>
          {group.items.map((item) => {
            // Keys are recorded per block, as the review sheet lists them.
            const isStaged = item.blocks.some((block) =>
              storageKeysForSection(block.id).some((key) => staged.has(key)),
            );
            return (
              <SideNavItem
                key={item.id}
                as={Link}
                href={`/settings/${item.id}`}
                label={settingsSectionName(t, item)}
                icon={<item.icon className={ACCENTS[SETTINGS_HUES[item.id] ?? "gray"].text} />}
                isSelected={pathname === `/settings/${item.id}`}
                // A description, not the name: "General staged" would stop matching by name.
                aria-description={isStaged ? t("homeStagedBadge") : undefined}
                endContent={isStaged ? <StagedDot /> : undefined}
              />
            );
          })}
        </SideNavSection>
      ))}
    </SideNav>
  );
}

/** A dot, not a count: the apply button already carries the number. */
function StagedDot() {
  return (
    // Visual only: the item's accessible description already says "staged".
    <span
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: "var(--color-warning)",
        display: "block",
      }}
    />
  );
}
