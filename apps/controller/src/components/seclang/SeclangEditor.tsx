"use client";

/**
 * SecLang, edited as text with suggestions or as a visual list of blocks. Both edit the same
 * string, so switching never converts anything; the form posts it from one hidden input.
 */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { CodeEditor, type CodeEditorIssue } from "@/components/ui/CodeEditor";
import { SeclangVisualEditor } from "./SeclangVisualEditor";
import { useSeclangAssist } from "./use-seclang-assist";

type Mode = "text" | "visual";

/** Per viewer, so a person who prefers the form keeps it across pages. */
const MODE_STORAGE_KEY = "cpm-seclang-editor-mode";

function storedMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "visual" ? "visual" : "text";
  } catch {
    return "text";
  }
}

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  htmlName?: string;
  description?: string;
  placeholder?: string;
  isReadOnly?: boolean;
  height?: "sm" | "md" | "lg";
  issues?: readonly CodeEditorIssue[];
  /** Ids the visual editor gives new rules start here, clear of the global ones. */
  idFloor?: number;
};

export function SeclangEditor({
  label,
  value,
  onChange,
  htmlName,
  description,
  placeholder,
  isReadOnly = false,
  height = "sm",
  issues = [],
  idFloor = 9000,
}: Props) {
  const t = useTranslations("seclang");
  const assist = useSeclangAssist();
  // Text on the server and the first paint; the stored choice applies once hydrated.
  const [mode, setMode] = useState<Mode>("text");
  useEffect(() => setMode(storedMode()), []);
  const choose = (next: Mode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  };

  return (
    <VStack gap={2}>
      {htmlName && <input type="hidden" name={htmlName} value={value} />}
      <HStack justify="between" vAlign="end" gap={3} wrap="wrap">
        <VStack gap={1}>
          <Text type="body" size="sm" weight="semibold">
            {label}
          </Text>
          {description && <Text type="supporting">{description}</Text>}
        </VStack>
        <SegmentedControl
          label={t("modeLabel")}
          size="sm"
          value={mode}
          onChange={(next) => choose(next as Mode)}
        >
          <SegmentedControlItem value="text" label={t("modeText")} />
          <SegmentedControlItem value="visual" label={t("modeVisual")} />
        </SegmentedControl>
      </HStack>
      {mode === "text" ? (
        <CodeEditor
          label={label}
          isLabelHidden
          language="seclang"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          isReadOnly={isReadOnly}
          height={height}
          issues={issues}
          assist={assist}
        />
      ) : (
        <SeclangVisualEditor
          value={value}
          onChange={onChange}
          issues={issues}
          isReadOnly={isReadOnly}
          idFloor={idFloor}
        />
      )}
    </VStack>
  );
}
