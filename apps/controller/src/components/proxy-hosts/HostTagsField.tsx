"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack } from "@astryxdesign/core/Stack";
import { Token } from "@astryxdesign/core/Token";
import { Tokenizer, type TokenizerChange } from "@astryxdesign/core/Tokenizer";
import {
  type SearchableItem,
  type SearchSource,
  Typeahead,
  TypeaheadItem,
} from "@astryxdesign/core/Typeahead";
import { Tag } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  HOST_TAG_MAX_LENGTH,
  HOST_TAGS_MAX,
  hostTagProblem,
  hostTagText,
} from "@/src/lib/proxy-hosts/tag-rules";

type UiT = ReturnType<typeof useTranslations<"ui.hostTags">>;
type TagItem = SearchableItem<{ typed?: boolean }>;

/** The reason a typed tag cannot be added, in the reader's language; null when it can. */
export function hostTagError(tag: string, existing: string[], t: UiT): string | null {
  if (!tag || existing.includes(tag)) return null;
  const problem = hostTagProblem(tag);
  if (problem === "invalid") return t("invalid");
  if (problem === "tooLong") return t("tooLong", { max: HOST_TAG_MAX_LENGTH });
  if (existing.length >= HOST_TAGS_MAX) return t("tooMany", { max: HOST_TAGS_MAX });
  return null;
}

const SuggestionsContext = createContext<string[]>([]);

/** The tags already in use on this kind of host, offered as suggestions by the fields below. */
export function HostTagSuggestions({ tags, children }: { tags: string[]; children: ReactNode }) {
  return <SuggestionsContext.Provider value={tags}>{children}</SuggestionsContext.Provider>;
}

/** A pasted comma-separated list is several tags. */
function typedTags(text: string): string[] {
  return text.split(",").map(hostTagText).filter(Boolean);
}

const asItem = (tag: string): TagItem => ({ id: tag, label: tag });
// Stable, since a new source mid-search makes Astryx drop that search's results.
const NONE: string[] = [];
// A tag holds no space, so this id never meets one in use.
const TYPED_ID = "typed ";

/**
 * What was typed comes first, so Enter adds it rather than the first suggestion. Its label is the
 * text itself, which also keeps Astryx's own untranslated "Create" row from showing beside it.
 */
function useTagSource(selected: string[]): SearchSource<TagItem> {
  const inUse = useContext(SuggestionsContext);
  return useMemo(
    () => ({
      search: (query: string) => {
        const typed = hostTagText(query);
        const matches = inUse
          .filter((tag) => tag.includes(typed))
          .sort((a, b) => Number(!a.startsWith(typed)) - Number(!b.startsWith(typed)));
        const offered = inUse.includes(typed) && !selected.includes(typed);
        const own: TagItem[] =
          typed && !offered
            ? [{ id: TYPED_ID + typed, label: typed, auxiliaryData: { typed: true } }]
            : [];
        return [...own, ...matches.map(asItem)];
      },
      bootstrap: () => inUse.map(asItem),
    }),
    [inUse, selected],
  );
}

function TagOption({ item, t }: { item: TagItem; t: UiT }) {
  return (
    <TypeaheadItem
      item={item.auxiliaryData?.typed ? { ...item, label: t("create", { tag: item.label }) } : item}
    />
  );
}

/**
 * A host's tags, shared by the HTTP and L4 editors. Each token is its own `tag` field; the marker
 * lets an update tell "every tag removed" from a form without the field.
 */
export function HostTagsField({ initial = [] }: { initial?: string[] }) {
  const t = useTranslations("ui.hostTags");
  const [tags, setTags] = useState<string[]>(initial);
  // What the error describes: the text being typed, or after a refusal what was refused, since
  // the Tokenizer empties its input on every pick.
  const [draft, setDraft] = useState("");
  const source = useTagSource(tags);
  // Stable for the same reason as NONE: the Tokenizer rebuilds its source from these.
  const items = useMemo(() => tags.map(asItem), [tags]);
  const error =
    typedTags(draft)
      .map((tag) => hostTagError(tag, tags, t))
      .find(Boolean) ?? null;

  function onChange(kept: TagItem[], change: TokenizerChange<TagItem>) {
    if (change.type !== "add" && change.type !== "create") {
      setTags(kept.map((item) => item.id));
      return;
    }
    const next = [...tags];
    const refused: string[] = [];
    for (const tag of typedTags(change.item.label)) {
      if (next.includes(tag)) continue;
      if (hostTagError(tag, next, t)) refused.push(tag);
      else next.push(tag);
    }
    setTags(next);
    setDraft(refused.join(", "));
  }

  return (
    <>
      <input type="hidden" name="tagsPresent" value="1" />
      <Tokenizer
        label={t("label")}
        description={t("help", { max: HOST_TAGS_MAX })}
        isOptional
        startIcon={Tag}
        placeholder={t("placeholder")}
        htmlName="tag"
        value={items}
        onChange={onChange}
        onChangeQuery={setDraft}
        searchSource={source}
        renderItem={(item) => <TagOption item={item} t={t} />}
        hasCreate
        maxEntries={HOST_TAGS_MAX}
        debounceMs={0}
        status={error ? { type: "error", message: error } : undefined}
      />
    </>
  );
}

/** A host's tags under its name in a list. */
export function HostTagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <HStack gap={1} wrap="wrap">
      {tags.map((tag) => (
        <Token key={tag} size="sm" label={tag} />
      ))}
    </HStack>
  );
}

/** The list's tag filter; empty when no host has a tag yet. */
export function HostTagFilter({
  tags,
  value,
  onChange,
}: {
  tags: string[];
  value: string | null;
  onChange: (tag: string | null) => void;
}) {
  const t = useTranslations("ui.hostTags");
  if (tags.length === 0 && !value) return null;
  const options = [...new Set([...tags, ...(value ? [value] : [])])].map((tag) => ({
    value: tag,
    label: tag,
  }));
  return (
    <Selector
      label={t("filterLabel")}
      isLabelHidden
      startIcon={Tag}
      placeholder={t("filterAll")}
      options={options}
      value={value}
      onChange={onChange}
      hasClear
      hasSearch={options.length > 8}
      size="sm"
      width={200}
    />
  );
}

/**
 * The one tag a bulk add puts on every selected host, checked as the editor checks one. Typed text
 * counts without being picked, so the dialog's button applies what the field shows.
 */
export function BulkTagInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations("ui.hostTags");
  const [picked, setPicked] = useState<TagItem | null>(null);
  const source = useTagSource(NONE);
  const error = hostTagError(hostTagText(value), [], t);
  return (
    <Typeahead
      label={t("bulkLabel")}
      description={t("bulkHelp")}
      isRequired
      startIcon={Tag}
      placeholder={t("bulkPlaceholder")}
      value={picked}
      onChange={(item) => {
        setPicked(item);
        onChange(item?.label ?? "");
      }}
      onChangeQuery={(query) => {
        setPicked(null);
        onChange(query);
      }}
      searchSource={source}
      renderItem={(item) => <TagOption item={item} t={t} />}
      debounceMs={0}
      status={error ? { type: "error", message: error } : undefined}
    />
  );
}
