/**
 * Settings search: every block, plus the admin pages that configure the instance outside the
 * settings sections, each with the words someone might look for it by. Synonyms live in the
 * catalog (`settings.search.synonyms.<block>`), so a translation can add its own; matching is
 * plain words, so "prometheus" finds Metrics and "smtp" finds Email. The global search palette
 * lists these and ranks everything it holds with `searchEntries`.
 */
import type { useTranslations } from "next-intl";
import {
  SETTINGS_ITEMS,
  groupForSection,
  sectionMessageName,
  settingsBlockName,
  settingsGroupLabel,
  settingsHref,
  settingsSectionDescription,
  settingsSectionName,
} from "./sections";

type SettingsTranslator = ReturnType<typeof useTranslations<"settings">>;

export type SettingsSearchEntry = {
  /** Unique: a block id, or `page:<id>` for the pages below. */
  id: string;
  href: string;
  title: string;
  /** Where it lives, shown under the title. */
  context: string;
  /** Searched, never shown: synonyms, the page's description, environment variables. */
  keywords: string[];
};

/**
 * Pages beyond the sections, added this release and earlier: Backup's portable configuration,
 * the WAF tabs that tune it, blocked sources and the sign-in overview.
 */
export const EXTRA_SEARCH_PAGES = [
  { id: "backup", href: "/settings/backup" },
  { id: "portable-config", href: "/settings/backup#portable-config" },
  { id: "audit-streaming", href: "/settings/audit-streaming" },
  { id: "settings-history", href: "/settings/history" },
  { id: "waf-tuning", href: "/waf?tab=settings" },
  { id: "waf-host-modes", href: "/waf?tab=hosts" },
  { id: "waf-exclusions", href: "/waf?tab=exclusions" },
  { id: "blocked-sources", href: "/security/blocked-sources" },
  { id: "sign-in-overview", href: "/users/sign-in" },
] as const;

type DynamicTranslate = ((key: string) => string) & { has: (key: string) => boolean };

function synonyms(t: DynamicTranslate, id: string): string[] {
  const key = `search.synonyms.${sectionMessageName(id)}`;
  return t.has(key)
    ? t(key)
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean)
    : [];
}

export function settingsSearchEntries(t: SettingsTranslator): SettingsSearchEntry[] {
  const dynamic = t as unknown as DynamicTranslate;
  const blocks = SETTINGS_ITEMS.flatMap((item) => {
    const page = settingsSectionName(t, item);
    const group = groupForSection(item.id);
    const shared = [
      settingsSectionDescription(t, item),
      group ? settingsGroupLabel(t, group) : "",
    ].filter(Boolean);
    return item.blocks.map(
      (block): SettingsSearchEntry => ({
        id: block.id,
        href: settingsHref(block.id),
        title: settingsBlockName(t, block.id),
        context: page,
        keywords: [
          ...synonyms(dynamic, block.id),
          ...shared,
          ...(block.env ?? []),
          ...(block.envSearch ?? []),
        ],
      }),
    );
  });
  const pages = EXTRA_SEARCH_PAGES.map(
    (page): SettingsSearchEntry => ({
      id: `page:${page.id}`,
      href: page.href,
      title: dynamic(`search.pages.${sectionMessageName(page.id)}.title`),
      context: dynamic(`search.pages.${sectionMessageName(page.id)}.context`),
      keywords: synonyms(dynamic, page.id),
    }),
  );
  return [...blocks, ...pages];
}

/** Lowercased, accents dropped, so "réseau" finds "reseau" and the other way round. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** What `searchEntries` reads: a title, the words it is found by, and where it lives. */
export type RankedEntry = { title: string; keywords: readonly string[]; context: string };

/**
 * Every word of the query must appear somewhere. A title match outranks a synonym, which outranks
 * the place an entry lives; ties keep the given order.
 */
export function searchEntries<T extends RankedEntry>(
  entries: readonly T[],
  query: string,
  limit = 12,
): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: Array<{ entry: T; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const title = fold(entry.title);
    const keywords = entry.keywords.map(fold);
    const context = fold(entry.context);
    let score = 0;
    for (const word of words) {
      if (title.startsWith(word)) score += 6;
      else if (title.includes(word)) score += 4;
      else if (keywords.some((keyword) => keyword.startsWith(word))) score += 3;
      else if (keywords.some((keyword) => keyword.includes(word))) score += 2;
      else if (context.includes(word)) score += 1;
      else return;
    }
    scored.push({ entry, score, index });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
