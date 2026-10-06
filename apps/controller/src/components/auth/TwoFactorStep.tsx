"use client";

import { ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { CheckboxInput } from "@/src/components/ui/FormBooleanControls";
import { AUTOFILL_ONE_TIME_CODE, NO_SPELLCHECK } from "@/src/components/ui/native-input-attrs";

// Brings up the number pad on phones; Astryx forwards it but doesn't type it.
const NUMERIC_INPUT = { inputMode: "numeric" } as Record<string, string>;

export type TwoFactorSubmission = {
  method: "totp" | "backup";
  code: string;
  trustDevice: boolean;
};

/** The portal passes `allowTrustDevice={false}`: its sign-in has no Better Auth trust cookie. */
export function TwoFactorStep({
  pending,
  allowTrustDevice = true,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  allowTrustDevice?: boolean;
  onSubmit: (submission: TwoFactorSubmission) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("auth.twoFactor");
  const tCommon = useTranslations("common");
  const [method, setMethod] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = code.replace(/\s+/g, "");
    if (!trimmed) return;
    onSubmit({ method, code: trimmed, trustDevice: allowTrustDevice && trustDevice });
  };

  return (
    <form onSubmit={handleSubmit}>
      <VStack gap={3}>
        <Text type="body" size="sm" color="secondary">
          {method === "totp" ? t("totpPrompt") : t("backupPrompt")}
        </Text>
        <TextInput
          startIcon={ShieldCheck}
          {...NO_SPELLCHECK}
          {...AUTOFILL_ONE_TIME_CODE}
          {...(method === "totp" ? NUMERIC_INPUT : {})}
          key={method}
          label={method === "totp" ? t("totpLabel") : t("backupLabel")}
          htmlName="code"
          value={code}
          onChange={setCode}
          isRequired
          hasAutoFocus
          isDisabled={pending}
          width="100%"
        />
        {allowTrustDevice && (
          <CheckboxInput
            label={t("trustDevice")}
            value={trustDevice}
            onChange={setTrustDevice}
            isDisabled={pending}
          />
        )}
        <Button
          type="submit"
          variant="primary"
          label={pending ? tCommon("verifying") : tCommon("verify")}
          isLoading={pending}
          isDisabled={pending}
          width="100%"
        />
        <Button
          variant="ghost"
          label={method === "totp" ? t("useBackupCode") : t("useAuthenticator")}
          isDisabled={pending}
          onClick={() => {
            setMethod(method === "totp" ? "backup" : "totp");
            setCode("");
          }}
          width="100%"
        />
        <Button
          variant="ghost"
          label={t("startOver")}
          isDisabled={pending}
          onClick={onCancel}
          width="100%"
        />
      </VStack>
    </form>
  );
}
