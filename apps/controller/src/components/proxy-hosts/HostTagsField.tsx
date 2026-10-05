"use client";

import { useState } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { Tag } from "lucide-react";
import { useTranslations } from "next-intl";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import {
  HOST_TAG_MAX_LENGTH,
  HOST_TAGS_MAX,
  hostTagProblem,
  hostTagText,
} from "@/src/lib/proxy-hosts/tag-rules";

type UiT = ReturnType<typeof useTranslations<"ui.hostTags">>;

/** The reason a typed tag cannot be added, in the reader's language; null when it can. */
export function hostTagError(tag: string, existing: string[], t: UiT): string | null {
  if (!tag || existing.includes(tag)) return null;
  const problem = hostTagProblem(tag);
  if (problem === "invalid") return t("invalid");
  if (problem === "tooLong") return t("tooLong", { max: HOST_TAG_MAX_LENGTH });
  if (existing.length >= HOST_TAGS_MAX) return t("tooMany", { max: HOST_TAGS_MAX });
  return null;
}

/**
 * Chips for a host's tags, shared by the HTTP and L4 editors. Each chip is its own `tag` field;
 * the marker lets an update tell "every chip removed" from a form without the field.
 */
export function HostTagsField({ initial = [] }: { initial?: string[] }) {
  const t = useTranslations("ui.hostTags");
  const [tags, setTags] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  // A pasted comma-separated list lands as several chips.
  const parts = draft.split(",").map(hostTagText).filter(Boolean);
  const error = parts.map((tag) => hostTagError(tag, tags, t)).find(Boolean) ?? null;

  function add() {
    const next = [...tags];
    const rejected: string[] = [];
    for (const tag of parts) {
      if (next.includes(tag)) continue;
      if (hostTagError(tag, next, t)) rejected.push(tag);
      else next.push(tag);
    }
    setTags(next.sort());
    // What could not be added stays in the box, beside its error.
    setDraft(rejected.join(", "));
  }

  return (
    <VStack gap={2}>
      <input type="hidden" name="tagsPresent" value="1" />
      {tags.map((tag) => (
        <input key={tag} type="hidden" name="tag" value={tag} />
      ))}
      <TextInput
        {...NO_SPELLCHECK}
        label={t("label")}
        startIcon={Tag}
        placeholder={t("placeholder")}
        value={draft}
        onChange={setDraft}
        isOptional
        description={t("help", { max: HOST_TAGS_MAX })}
        status={error ? { type: "error", message: error } : undefined}
        onEnter={add}
        // Enter would otherwise submit the host form mid-edit, and a comma ends a chip.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
          if (e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
      />
      {tags.length > 0 && (
        <HStack gap={2} wrap="wrap">
          {tags.map((tag) => (
            <Token
              key={tag}
              size="sm"
              label={tag}
              onRemove={() => setTags((prev) => prev.filter((other) => other !== tag))}
            />
          ))}
        </HStack>
      )}
    </VStack>
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

/** The one tag a bulk add puts on every selected host, checked as the editor checks a chip. */
export function BulkTagInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations("ui.hostTags");
  const error = hostTagError(hostTagText(value), [], t);
  return (
    <TextInput
      {...NO_SPELLCHECK}
      label={t("bulkLabel")}
      startIcon={Tag}
      placeholder={t("placeholder")}
      value={value}
      onChange={onChange}
      isRequired
      description={t("bulkHelp")}
      status={error ? { type: "error", message: error } : undefined}
    />
  );
}
