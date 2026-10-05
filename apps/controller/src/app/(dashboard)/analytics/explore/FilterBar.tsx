"use client";

/**
 * The page's filters as tokens: each is a field, is or is not, and a value. Values a field can
 * never match are dropped by the same parser that reads the URL, so the bar never shows a token
 * the queries ignore.
 */

import { useMemo } from "react";
import { Filter } from "lucide-react";
import { PowerSearch } from "@astryxdesign/core/PowerSearch";
import type {
  OperatorValue,
  PowerSearchConfig,
  PowerSearchField,
  PowerSearchFilter,
} from "@astryxdesign/core/PowerSearch";
import type { SearchableItem, SearchSource } from "@astryxdesign/core/Typeahead";
import { TRAFFIC_OUTCOMES } from "@cpm/shared";
import { useTranslations } from "next-intl";
import {
  type AnalyticsFilter,
  dedupeFilters,
  FILTER_FIELDS,
  type FilterField,
  normalizeFilterValue,
} from "@/src/lib/analytics/explore-state";
import { FIELD_KEY } from "./format";
import { useOutcomeLabel } from "./TopList";

// Astryx ships these labels in every locale; no catalog entries needed.
const IS = { key: "is", i18nKey: "@astryx.powersearch.operator.is" } as const;
const IS_NOT = { key: "not", i18nKey: "@astryx.powersearch.operator.isNot" } as const;

const STATUS_SUGGESTIONS = [
  "2xx",
  "3xx",
  "4xx",
  "5xx",
  "200",
  "301",
  "302",
  "304",
  "401",
  "403",
  "404",
  "429",
  "500",
  "502",
  "503",
  "504",
];
const METHOD_SUGGESTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const PROTO_SUGGESTIONS = ["HTTP/1.0", "HTTP/1.1", "HTTP/2.0", "HTTP/3.0"];

function staticSource(values: readonly string[]): SearchSource {
  const items: SearchableItem[] = values.map((value) => ({ id: value, label: value }));
  return {
    search: (query) =>
      items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    bootstrap: () => items,
  };
}

function filterValue(filter: PowerSearchFilter): string | null {
  const value = filter.value;
  if (value.type === "string" || value.type === "enum") return value.value;
  return null;
}

export function FilterBar({
  filters,
  onChange,
  suggestions,
}: {
  filters: readonly AnalyticsFilter[];
  onChange: (filters: AnalyticsFilter[]) => void;
  /** Values offered for a field as it is typed, e.g. the configured hosts. */
  suggestions?: Partial<Record<FilterField, readonly string[]>>;
}) {
  const t = useTranslations("analytics");
  const outcomeLabel = useOutcomeLabel();

  const config = useMemo<PowerSearchConfig>(() => {
    const valueFor = (field: FilterField): OperatorValue => {
      if (field === "outcome") {
        return {
          type: "enum",
          values: TRAFFIC_OUTCOMES.map((outcome) => ({
            value: outcome,
            label: outcomeLabel(outcome),
          })),
        };
      }
      const offered =
        suggestions?.[field] ??
        (field === "status"
          ? STATUS_SUGGESTIONS
          : field === "method"
            ? METHOD_SUGGESTIONS
            : field === "proto"
              ? PROTO_SUGGESTIONS
              : undefined);
      return {
        type: "string",
        isArbitraryStringAllowed: true,
        ...(offered ? { searchSource: staticSource(offered) } : {}),
      };
    };
    return {
      name: "AnalyticsFilters",
      fields: FILTER_FIELDS.map(
        (field): PowerSearchField => ({
          key: field,
          label: t(`filterFields.${FIELD_KEY[field]}`),
          defaultOperator: IS.key,
          operators: [
            { ...IS, value: valueFor(field) },
            { ...IS_NOT, value: valueFor(field) },
          ],
        }),
      ),
    };
  }, [t, outcomeLabel, suggestions]);

  const tokens = useMemo<PowerSearchFilter[]>(
    () =>
      filters.map((filter) => ({
        field: filter.field,
        operator: filter.op,
        value:
          filter.field === "outcome"
            ? { type: "enum", value: filter.value }
            : { type: "string", value: filter.value },
      })),
    [filters],
  );

  function handleChange(next: ReadonlyArray<PowerSearchFilter>) {
    const parsed: AnalyticsFilter[] = [];
    for (const token of next) {
      if (!(FILTER_FIELDS as readonly string[]).includes(token.field)) continue;
      const field = token.field as FilterField;
      const raw = filterValue(token);
      const value = raw === null ? null : normalizeFilterValue(field, raw);
      if (value === null) continue;
      parsed.push({ field, op: token.operator === IS_NOT.key ? "not" : "is", value });
    }
    onChange(dedupeFilters(parsed));
  }

  return (
    <PowerSearch
      config={config}
      filters={tokens}
      onChange={handleChange}
      label={t("filtersLabel")}
      placeholder={t("filtersPlaceholder")}
      startIcon={<Filter />}
      tokenOverflowBehavior="unfocusedInline"
      style={{ width: "100%" }}
    />
  );
}
