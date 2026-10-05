"use client";

/**
 * Every page the role can open, and for an admin every settings section, searchable by its
 * description, group and env vars. The provider owns open state so either rail can open it.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type LucideIcon, Search, Settings2 } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { CommandPalette } from "@astryxdesign/core/CommandPalette";
import { Kbd } from "@astryxdesign/core/Kbd";
import { createStaticSource } from "@astryxdesign/core/Typeahead/utils";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { DESTINATION_HUES, DESTINATION_ICONS } from "@/src/components/mobile/nav-icons";
import { ACCENTS, type Hue } from "@/src/components/ui/accent";
import { visibleDestinations } from "@/src/lib/nav/destinations";
import {
  SETTINGS_HUES,
  SETTINGS_ITEMS,
  groupForSection,
  settingsGroupLabel,
  settingsBlockName,
  settingsSectionDescription,
  settingsSectionName,
} from "@/src/app/(dashboard)/settings/sections";
import { settingsSearchEntries } from "@/src/app/(dashboard)/settings/search-index";

type PaletteItem = {
  /** The page it opens; unique, so it doubles as the id. */
  id: string;
  label: string;
  auxiliaryData: {
    /** CommandPalette groups on it. */
    group: string;
    desc: string;
    /** Searchable but not shown. */
    keywords: string[];
    icon: LucideIcon;
    /** The colour the navigation shows it in. */
    hue?: Hue;
  };
};

const PaletteContext = createContext<{ open: () => void }>({ open: () => {} });

export function useCommandPalette() {
  return useContext(PaletteContext);
}

export function PaletteSearchButton() {
  const t = useTranslations("commandPalette");
  const { open } = useCommandPalette();
  return (
    <Button
      variant="secondary"
      size="sm"
      width="100%"
      icon={<Search />}
      label={t("searchButton")}
      endContent={<Kbd keys="mod+K" />}
      onClick={open}
    />
  );
}

export function GlobalCommandPaletteProvider({
  role,
  children,
}: {
  /** Decides which pages, and whether settings, are listed. */
  role: string | undefined;
  children: ReactNode;
}) {
  const t = useTranslations("commandPalette");
  const tNav = useTranslations("nav");
  const tSettings = useTranslations("settings");
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // A held shortcut repeats, and would flicker the palette open and shut.
        if (event.repeat) return;
        setIsOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Enter takes the top result when nothing is highlighted: Astryx highlights only on arrow or
  // pointer, so "type, Enter" did nothing. Clicking the row reuses the palette's own selection.
  useEffect(() => {
    if (!isOpen) return;
    function handler(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.isComposing) return;
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.getAttribute("role") !== "combobox") return;
      if (input.getAttribute("aria-activedescendant")) return;
      const listId = input.getAttribute("aria-controls");
      const first = listId
        ? document.getElementById(listId)?.querySelector<HTMLElement>('[role="option"]')
        : null;
      if (!first) return;
      event.preventDefault();
      event.stopPropagation();
      first.click();
    }
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [isOpen]);

  // Per language rather than module scope: it matches translated names.
  const searchSource = useMemo(() => {
    const pages: PaletteItem[] = visibleDestinations(role).map((destination) => ({
      id: destination.href,
      label: tNav(destination.labelKey),
      auxiliaryData: {
        group: t("groupPages"),
        desc: "",
        keywords: [destination.id],
        icon: DESTINATION_ICONS[destination.id],
        hue: DESTINATION_HUES[destination.id],
      },
    }));

    // Admin-only pages; anyone else would only be refused. Synonyms come from the settings
    // search index, so "smtp" finds Email here as on the Settings page.
    const searchEntries = role === "admin" ? settingsSearchEntries(tSettings) : [];
    const keywordsFor = new Map(searchEntries.map((entry) => [entry.id, entry.keywords]));
    const settings: PaletteItem[] =
      role === "admin"
        ? SETTINGS_ITEMS.map((item) => {
            const group = groupForSection(item.id);
            return {
              id: `/settings/${item.id}`,
              label: settingsSectionName(tSettings, item),
              auxiliaryData: {
                group: tNav("settings"),
                desc: settingsSectionDescription(tSettings, item),
                keywords: [
                  group ? settingsGroupLabel(tSettings, group) : "",
                  // So a page is found by anything it carries, not only its name.
                  ...item.blocks.flatMap((block) => [
                    settingsBlockName(tSettings, block.id),
                    ...(keywordsFor.get(block.id) ?? []),
                  ]),
                ],
                icon: item.icon,
                hue: SETTINGS_HUES[item.id],
              },
            };
          })
        : [];
    // The blocks a page holds, and the admin pages outside the sections, each its own row.
    const pageHrefs = new Set(settings.map((item) => item.id));
    const settingsBlocks: PaletteItem[] = searchEntries
      .filter((entry) => !pageHrefs.has(entry.href))
      .map((entry) => ({
        id: entry.href,
        label: entry.title,
        auxiliaryData: {
          group: tNav("settings"),
          desc: entry.context,
          keywords: entry.keywords,
          icon: Settings2,
        },
      }));

    const items = [...pages, ...settings, ...settingsBlocks];
    return createStaticSource(items, {
      keywords: (item) => [item.auxiliaryData.desc, ...item.auxiliaryData.keywords],
    });
  }, [role, t, tNav, tSettings]);

  return (
    <PaletteContext value={{ open: () => setIsOpen(true) }}>
      {children}
      {/* Only while open, or every page would have two search fields in its DOM. */}
      {isOpen && (
        <CommandPalette
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          label={t("label")}
          searchSource={searchSource}
          emptySearchText={t("empty")}
          onValueChange={(href) => {
            setIsOpen(false);
            router.push(href);
          }}
          renderItem={(item) => (
            <HStack gap={3} vAlign="center">
              {item.auxiliaryData.hue ? (
                <Icon
                  icon={item.auxiliaryData.icon}
                  size="sm"
                  className={ACCENTS[item.auxiliaryData.hue].text}
                />
              ) : (
                <Icon icon={item.auxiliaryData.icon} size="sm" color="secondary" />
              )}
              <VStack gap={0}>
                <Text type="body" size="sm" weight="medium">
                  {item.label}
                </Text>
                {item.auxiliaryData.desc && (
                  <Text type="body" size="xsm" color="secondary" maxLines={1}>
                    {item.auxiliaryData.desc}
                  </Text>
                )}
              </VStack>
            </HStack>
          )}
        />
      )}
    </PaletteContext>
  );
}
