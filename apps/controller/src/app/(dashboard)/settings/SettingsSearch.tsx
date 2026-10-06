"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Typeahead } from "@astryxdesign/core/Typeahead";
import type { SearchSource } from "@astryxdesign/core/Typeahead/utils";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { searchSettings, settingsSearchEntries } from "./search-index";

type Item = { id: string; label: string; auxiliaryData: { href: string; context: string } };

/** Picking a result goes there; nothing stays selected, so the field is ready for the next. */
export function SettingsSearch() {
  const t = useTranslations("settings");
  const router = useRouter();
  const entries = useMemo(() => settingsSearchEntries(t), [t]);
  const source = useMemo<SearchSource<Item>>(
    () => ({
      search: (query) =>
        searchSettings(entries, query).map((entry) => ({
          id: entry.id,
          label: entry.title,
          auxiliaryData: { href: entry.href, context: entry.context },
        })),
      bootstrap: () => [],
    }),
    [entries],
  );

  return (
    <Typeahead<Item>
      label={t("search.label")}
      isLabelHidden
      placeholder={t("search.placeholder")}
      startIcon={Search}
      width="100%"
      debounceMs={0}
      searchSource={source}
      value={null}
      emptySearchResultsText={t("search.empty")}
      onChange={(item) => {
        if (item) router.push(item.auxiliaryData.href);
      }}
      renderItem={(item) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="medium">
            {item.label}
          </Text>
          <Text type="body" size="sm" color="secondary">
            {item.auxiliaryData.context}
          </Text>
        </VStack>
      )}
    />
  );
}
