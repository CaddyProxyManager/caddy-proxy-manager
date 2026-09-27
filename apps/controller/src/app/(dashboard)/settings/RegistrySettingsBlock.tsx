"use client";

/** Renders from the registry definitions rather than repeating their decisions. */

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
  | { kind: "number"; value: number; min: number; max: number }
);

export function RegistrySettingsBlock({
  block,
  fields,
  state,
  formAction,
}: {
  /** Tells the action which settings the submission may write. */
  block: string;
  fields: readonly RegistryField[];
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
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
                field.pinned ? t("envPinnedHelp", { variable: field.env }) : field.description
              }
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
}: {
  field: RegistryField;
  badgeLabel: string;
  description: string;
}) {
  // Only for the variable: the one case where the value did not come from this form.
  const badge = field.source === "environment" ? <Badge variant="blue" label={badgeLabel} /> : null;

  if (field.kind === "boolean")
    return <BooleanField field={field} badge={badge} description={description} />;
  if (field.kind === "number")
    return <NumberField field={field} badge={badge} description={description} />;
  return <TextField field={field} badge={badge} description={description} />;
}

type Badged = { badge: ReactNode; description: string };

function BooleanField({
  field,
  badge,
  description,
}: { field: RegistryField & { kind: "boolean" } } & Badged) {
  const [value, setValue] = useFieldValue(field.value);
  return (
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
        isDisabled={field.pinned}
      />
    </EnvLabelledField>
  );
}

function NumberField({
  field,
  badge,
  description,
}: { field: RegistryField & { kind: "number" } } & Badged) {
  const [value, setValue] = useFieldValue(field.value);
  return (
    <EnvLabelledField label={field.label} env={[field.env]} description={description} badge={badge}>
      <NumberInput
        label={field.label}
        htmlName={field.key}
        value={value}
        onChange={setValue}
        isDisabled={field.pinned}
        isIntegerOnly
        min={field.min}
        max={field.max}
      />
    </EnvLabelledField>
  );
}

function TextField({
  field,
  badge,
  description,
}: { field: RegistryField & { kind: "text" } } & Badged) {
  const [value, setValue] = useFieldValue(field.value);
  return (
    <EnvLabelledField label={field.label} env={[field.env]} description={description} badge={badge}>
      <TextInput
        {...AUTOFILL_OFF}
        label={field.label}
        placeholder={field.placeholder}
        htmlName={field.key}
        value={value}
        onChange={setValue}
        isDisabled={field.pinned}
      />
    </EnvLabelledField>
  );
}
