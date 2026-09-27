"use client";

import { type ComponentProps, type FocusEvent, useState } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useTranslations } from "next-intl";
import { type EmailDomain, isEmailAddress } from "@/src/lib/email-address";
import { NO_SPELLCHECK } from "./native-input-attrs";

type EmailInputProps = Omit<ComponentProps<typeof TextInput>, "type" | "status" | "value"> & {
  value: string;
  /** `public` for an address a third party must accept, such as the ACME contact. */
  domain?: EmailDomain;
};

/**
 * Checked from the first blur, so a half-typed address is not flagged. A convenience only: the
 * save applies the same rule.
 */
export function EmailInput({ domain = "any", value, ...props }: EmailInputProps) {
  const t = useTranslations("errors");
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const invalid = touched && trimmed !== "" && !isEmailAddress(trimmed, domain);

  // TextInput forwards an untyped onBlur to the <input>; chain the consumer's rather than replace.
  const consumerOnBlur = (props as Record<string, unknown>).onBlur;
  const onBlur = {
    onBlur: (event: FocusEvent<HTMLInputElement>) => {
      setTouched(true);
      if (typeof consumerOnBlur === "function") consumerOnBlur(event);
    },
  } as Record<string, unknown>;

  return (
    <TextInput
      {...NO_SPELLCHECK}
      {...props}
      {...onBlur}
      type="email"
      value={value}
      status={invalid ? { type: "error", message: t("emailInvalid") } : undefined}
    />
  );
}
