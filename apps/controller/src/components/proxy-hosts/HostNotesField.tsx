"use client";

import { Icon } from "@astryxdesign/core/Icon";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { StickyNote } from "lucide-react";
import { useTranslations } from "next-intl";
import { HOST_DESCRIPTION_MAX_LENGTH } from "@/src/lib/proxy-hosts/description-limit";

/** Shared by the HTTP and L4 editors. */
export function HostNotesField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("proxyHosts");
  return (
    <TextArea
      label={t("notes")}
      htmlName="description"
      value={value}
      onChange={onChange}
      rows={2}
      maxLength={HOST_DESCRIPTION_MAX_LENGTH}
      isOptional
      description={t("notesHelp")}
    />
  );
}

/** A note icon beside a host's name in a table, with the notes on hover. */
export function HostNotesHint({ notes }: { notes: string | null }) {
  const t = useTranslations("proxyHosts");
  if (!notes) return null;
  return (
    <Tooltip content={notes}>
      <Icon icon={StickyNote} size="xsm" color="secondary" label={t("notes")} />
    </Tooltip>
  );
}
