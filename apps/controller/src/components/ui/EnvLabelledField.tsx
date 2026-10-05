"use client";

/**
 * A control whose label line also names its environment variable. Design-system labels are plain
 * strings, so the control's label is hidden (still its accessible name) and drawn here, pointed at
 * the control's id once mounted. Checkboxes and switches pass `layout="inline"`.
 */

import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { EnvTokens } from "./EnvTokens";

type ControlProps = {
  label: string;
  isLabelHidden?: boolean;
  ref?: React.Ref<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
};

export function EnvLabelledField({
  label,
  env,
  description,
  layout = "stacked",
  badge,
  children,
}: {
  label: string;
  /** The variables that set this one field. */
  env: readonly string[];
  /** Something to say about this field beside its name, such as where its value came from. */
  badge?: ReactNode;
  /** Hiding a control's label hides its description too, so a visible one is handed over here. */
  description?: string;
  layout?: "stacked" | "inline";
  /** One design-system control. It is given `isLabelHidden` and a ref. */
  children: ReactElement<ControlProps>;
}) {
  const controlRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  const [controlId, setControlId] = useState<string>();
  const labelId = useId();

  // The control generates its id, so it only has one after mount.
  useEffect(() => setControlId(controlRef.current?.id), []);

  const labelLine = (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <label id={labelId} htmlFor={controlId} className="cursor-pointer">
        <Text type="label">{label}</Text>
      </label>
      <EnvTokens names={env} />
      {badge}
    </HStack>
  );
  const control = cloneElement(children, { isLabelHidden: true, ref: controlRef });

  if (layout === "inline") {
    // The description starts under the label, not the box, which centres across both lines.
    return (
      <HStack gap={3} vAlign="center">
        {control}
        <StackItem size="fill">
          <VStack gap={0}>
            {labelLine}
            {description && (
              <Text size="xsm" color="secondary">
                {description}
              </Text>
            )}
          </VStack>
        </StackItem>
      </HStack>
    );
  }

  return (
    <VStack gap={1}>
      {labelLine}
      {description && (
        <Text size="xsm" color="secondary">
          {description}
        </Text>
      )}
      {control}
    </VStack>
  );
}
