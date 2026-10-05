"use client";

import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";

export type SheetOption<V extends string> = {
  value: V;
  label: string;
  description?: string;
};

/**
 * A bottom sheet with one choice to make, the partner of FilterChip. Picking an option applies it
 * and closes the sheet: there is nothing else in it to confirm.
 */
export function OptionSheet<V extends string>({
  title,
  isOpen,
  onOpenChange,
  value,
  options,
  onChange,
}: {
  title: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  value: V;
  options: SheetOption<V>[];
  onChange: (value: V) => void;
}) {
  return (
    <BottomSheet label={title} isOpen={isOpen} onOpenChange={onOpenChange} height="hug">
      {/* Clear of the grab handle, which overlays the top of the content. */}
      <VStack gap={3} paddingInline={4} paddingBlockStart={6} paddingBlockEnd={4}>
        <Text type="body" weight="semibold" justify="center">
          {title}
        </Text>
        <RadioList
          label={title}
          isLabelHidden
          value={value}
          onChange={(next) => {
            onChange(next as V);
            onOpenChange(false);
          }}
        >
          {options.map((option) => (
            <RadioListItem
              key={option.value}
              value={option.value}
              label={option.label}
              description={option.description}
            />
          ))}
        </RadioList>
      </VStack>
    </BottomSheet>
  );
}
