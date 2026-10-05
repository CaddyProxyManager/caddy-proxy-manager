"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Popover } from "@astryxdesign/core/Popover";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { generatePassword } from "@/src/lib/auth/password/generator";
import {
  AUTOFILL_NEW_PASSWORD,
  NATIVE_REQUIRED,
  nativeAttrs,
} from "@/src/components/ui/native-input-attrs";

interface GeneratedPasswordFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Replaces `onChange` on generate, so a confirmation partner can be filled too. */
  onGenerate?: (password: string) => void;
  htmlName?: string;
  description?: string;
  placeholder?: string;
  isRequired?: boolean;
  isOptional?: boolean;
  isDisabled?: boolean;
  /** Empty values are unaffected. */
  minLength?: number;
  width?: string;
  "data-testid"?: string;
}

/**
 * For values the app chooses (a ClickHouse password, not a Tailscale auth key). Reveal and copy
 * come with it: a masked random string is useless to the person it is handed to.
 */
export function GeneratedPasswordField({
  label,
  value,
  onChange,
  onGenerate,
  htmlName,
  description,
  placeholder,
  isRequired,
  isOptional,
  isDisabled,
  minLength,
  width = "100%",
  "data-testid": testId,
}: GeneratedPasswordFieldProps) {
  const t = useTranslations("ui.passwordField");
  const [isRevealed, setIsRevealed] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);
  // No clipboard API on plain http, so the button explains instead. Read after mount.
  const [canCopy, setCanCopy] = useState(true);
  useEffect(() => setCanCopy(window.isSecureContext), []);

  const generate = () => {
    const password = generatePassword();
    // A generated value is unknown, so masking it would force the toggle every time.
    setIsRevealed(true);
    (onGenerate ?? onChange)(password);
  };

  const copy = async () => {
    if (!value) return;
    if (!canCopy) {
      // Revealed so the value the popover asks them to copy is there to select.
      setIsRevealed(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setHasCopied(true);
      // Not a toast: easy to miss in dialogs; the tick sits next to what it is about.
      setTimeout(() => setHasCopied(false), 2_000);
    } catch {
      // Some webviews deny it; the value is revealed and selectable anyway.
    }
  };

  return (
    <HStack gap={2} vAlign="end" width={width}>
      <TextInput
        startIcon={KeyRound}
        {...AUTOFILL_NEW_PASSWORD}
        {...(isRequired ? NATIVE_REQUIRED : {})}
        {...(minLength === undefined ? {} : nativeAttrs({ minLength }))}
        data-testid={testId}
        label={label}
        type={isRevealed ? "text" : "password"}
        htmlName={htmlName}
        description={description}
        placeholder={placeholder}
        isRequired={isRequired}
        isOptional={isOptional}
        isDisabled={isDisabled}
        value={value}
        onChange={onChange}
        width="100%"
      />
      <IconButton
        variant="secondary"
        label={t("generateLabel")}
        tooltip={t("generateTooltip")}
        icon={<Sparkles />}
        isDisabled={isDisabled}
        onClick={generate}
      />
      <IconButton
        variant="secondary"
        label={isRevealed ? t("hideLabel") : t("revealLabel")}
        tooltip={isRevealed ? t("hideLabel") : t("revealLabel")}
        icon={isRevealed ? <EyeOff /> : <Eye />}
        isDisabled={isDisabled || !value}
        onClick={() => setIsRevealed((shown) => !shown)}
      />
      <Popover
        isEnabled={!canCopy}
        label={t("copyUnavailableTitle")}
        placement="below"
        alignment="end"
        width={280}
        content={
          <VStack gap={1} padding={3}>
            <Text size="sm" weight="medium">
              {t("copyUnavailableTitle")}
            </Text>
            <Text size="sm" color="secondary">
              {t("copyUnavailableDescription")}
            </Text>
          </VStack>
        }
      >
        <IconButton
          variant="secondary"
          label={hasCopied ? t("copiedLabel") : t("copyLabel")}
          tooltip={hasCopied ? t("copiedLabel") : t("copyLabel")}
          icon={hasCopied ? <Check /> : <Copy />}
          isDisabled={isDisabled || !value}
          onClick={copy}
        />
      </Popover>
    </HStack>
  );
}
