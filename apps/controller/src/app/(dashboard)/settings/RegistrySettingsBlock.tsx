"use client";

/** Renders from the registry definitions rather than repeating their decisions. */

import { CalendarDays, Clock, type LucideIcon } from "lucide-react";
import type { SettingUnit } from "@/src/lib/settings/registry";
import { type ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@astryxdesign/core/Badge";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { VStack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useTranslations } from "next-intl";
import { AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { EnvLabelledField } from "@/src/components/ui/EnvLabelledField";
import { FormCard, StatusAlert } from "@/src/components/ui/FormLayout";

/** A duration gets a clock, a count of days a calendar; a plain count no icon. */
const UNIT_ICONS: Partial<Record<SettingUnit, LucideIcon>> = {
  milliseconds: Clock,
  seconds: Clock,
  minutes: Clock,
  hours: Clock,
  days: CalendarDays,
};

export type RegistryField = {
  /** Also the name the field posts under. */
  key: string;
  env: string;
  label: string;
  description: string;
  source?: "stored" | "environment" | "default";
  /** The variable overrides what is stored. */
  pinned?: boolean;
} & (
  | { kind: "text"; value: string; maxLength?: number; placeholder?: string }
  | { kind: "boolean"; value: boolean }
  | {
      kind: "number";
      value: number;
      min: number;
      max: number;
      /** The suffix, already translated, and what it counts, which picks the icon. */
      units?: string;
      unit?: SettingUnit;
    }
);

export function RegistrySettingsBlock({
  block,
  fields,
  state,
  formAction,
  unavailable = {},
}: {
  /** Tells the action which settings the submission may write. */
  block: string;
  fields: readonly RegistryField[];
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
  /** Fields greyed out because nothing could act on them now, keyed to the reason shown instead. */
  unavailable?: Record<string, string>;
}) {
  const t = useTranslations("settings");
  const router = useRouter();

  // The open page keeps its old payload after a server revalidate until asked for a new one.
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);

  if (fields.length === 0) return null;

  return (
    <FormCard>
      <form action={formAction}>
        <input type="hidden" name="registryBlock" value={block} />
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          {fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              badgeLabel={field.pinned ? t("envPinned") : t("envOverride")}
              // Replaces the description: a greyed-out control needs the why, not the what.
              description={
                field.pinned
                  ? t("envPinnedHelp", { variable: field.env })
                  : (unavailable[field.key] ?? field.description)
              }
              isUnavailable={field.key in unavailable}
            />
          ))}
        </VStack>
      </form>
    </FormCard>
  );
}

/** React resets a form after its action, so a saved checkbox flicks back off unless re-synced. */
function useFieldValue<T>(serverValue: T): [T, (next: T) => void] {
  const [value, setValue] = useState(serverValue);
  const [seen, setSeen] = useState(serverValue);
  if (seen !== serverValue) {
    setSeen(serverValue);
    setValue(serverValue);
  }
  return [value, setValue];
}

/**
 * Each kind draws its own `EnvLabelledField`, which only relabels a direct design-system child.
 * Controlled, because the save bar reads dirtiness from what the controls hold.
 */
function FieldControl({
  field,
  badgeLabel,
  description,
  isUnavailable,
}: {
  field: RegistryField;
  badgeLabel: string;
  description: string;
  isUnavailable: boolean;
}) {
  // Only for the variable: the one case where the value did not come from this form.
  const badge = field.source === "environment" ? <Badge variant="blue" label={badgeLabel} /> : null;

  const props = { badge, description, isUnavailable };
  if (field.kind === "boolean") return <BooleanField field={field} {...props} />;
  if (field.kind === "number") return <NumberField field={field} {...props} />;
  return <TextField field={field} {...props} />;
}

/**
 * Unavailable is not pinned: greyed out, yet saved as it stands through a hidden copy, since a
 * disabled control posts nothing and the action would store a switch as off.
 */
type Badged = { badge: ReactNode; description: string; isUnavailable: boolean };

function KeepValue({ field, value }: { field: RegistryField; value: string | number | boolean }) {
  if (field.pinned) return null;
  return <input type="hidden" name={field.key} value={String(value)} />;
}

function BooleanField({
  field,
  badge,
  description,
  isUnavailable,
}: { field: RegistryField & { kind: "boolean" } } & Badged) {
  const [value, setValue] = useFieldValue(field.value);
  return (
    <>
      <EnvLabelledField
        label={field.label}
        env={[field.env]}
        description={description}
        layout="inline"
        badge={badge}
      >
        <Switch
          label={field.label}
          htmlName={field.key}
          value={value}
          onChange={setValue}
          isDisabled={field.pinned || isUnavailable}
        />
      </EnvLabelledField>
      {isUnavailable && <KeepValue field={field} value={value} />}
    </>
  );
}

function NumberField({
  field,
  badge,
  description,
  isUnavailable,
}: { field: RegistryField & { kind: "number" } } & Badged) {
  const [value, setValue] = useFieldValue(field.value);
  return (
    <>
      <EnvLabelledField
        label={field.label}
        env={[field.env]}
        description={description}
        badge={badge}
      >
        <NumberInput
          hasNumberSteppers
          units={field.units}
          startIcon={field.unit ? UNIT_ICONS[field.unit] : undefined}
          label={field.label}
          htmlName={field.key}
          value={value}
          onChange={setValue}
          isDisabled={field.pinned || isUnavailable}
          isIntegerOnly
          min={field.min}
          max={field.max}
        />
      </EnvLabelledField>
      {isUnavailable && <KeepValue field={field} value={value} />}
    </>
  );
}

function TextField({
  field,
  badge,
  description,
  isUnavailable,
}: { field: RegistryField & { kind: "text" } } & Badged) {
  const [value, setValue] = useFieldValue(field.value);
  return (
    <>
      <EnvLabelledField
        label={field.label}
        env={[field.env]}
        description={description}
        badge={badge}
      >
        <TextInput
          {...AUTOFILL_OFF}
          label={field.label}
          placeholder={field.placeholder}
          htmlName={field.key}
          value={value}
          onChange={setValue}
          isDisabled={field.pinned || isUnavailable}
        />
      </EnvLabelledField>
      {isUnavailable && <KeepValue field={field} value={value} />}
    </>
  );
}
