"use client";

import { KeyRound, Link } from "lucide-react";
import { useState } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { FormCard, InfoAlert, StatusAlert } from "@/src/components/ui/FormLayout";
import { CAPTCHA_PROVIDERS, type CaptchaProvider } from "@/src/lib/captcha/providers";
import type { CaptchaSettingsView } from "@/src/lib/captcha/settings";

type ProviderChoice = CaptchaProvider | "none";

export function CaptchaSection({
  captcha,
  localUsersDisabled,
  captchaState,
  captchaFormAction,
}: {
  captcha: CaptchaSettingsView;
  localUsersDisabled: boolean;
  captchaState: { success: boolean; message?: string } | null;
  captchaFormAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.captcha");
  const [provider, setProvider] = useState<ProviderChoice>(captcha.provider);
  const [siteKey, setSiteKey] = useState(captcha.siteKey);
  const [secretKey, setSecretKey] = useState("");
  const [capInstanceUrl, setCapInstanceUrl] = useState(captcha.capInstanceUrl);
  // The stored secret is only kept for the provider that issued it; see the action.
  const secretStored = captcha.hasSecretKey && provider === captcha.provider;

  return (
    <FormCard>
      <form action={captchaFormAction}>
        <VStack gap={3}>
          {captchaState?.message && (
            <StatusAlert message={captchaState.message} success={captchaState.success} />
          )}
          {localUsersDisabled && provider !== "none" && (
            <InfoAlert title={t("oidcOnlyTitle")}>{t("oidcOnlyBody")}</InfoAlert>
          )}
          <Selector
            label={t("provider")}
            description={t("providerHelp")}
            htmlName="captchaProvider"
            options={(["none", ...CAPTCHA_PROVIDERS] as const).map((value) => ({
              value,
              label: t(`providers.${value}`),
            }))}
            value={provider}
            onChange={(value) => setProvider(value as ProviderChoice)}
          />
          {provider !== "none" && (
            <>
              {provider === "cap" && (
                <TextInput
                  startIcon={Link}
                  {...AUTOFILL_OFF}
                  label={t("capInstanceUrl")}
                  description={t("capInstanceUrlHelp")}
                  htmlName="captchaCapInstanceUrl"
                  value={capInstanceUrl}
                  onChange={setCapInstanceUrl}
                  placeholder="https://cap.example.com"
                />
              )}
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_OFF}
                label={t("siteKey")}
                description={t("siteKeyHelp")}
                htmlName="captchaSiteKey"
                value={siteKey}
                onChange={setSiteKey}
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={t("secretKey")}
                type="password"
                isOptional={secretStored}
                description={secretStored ? t("secretKeyStored") : t("secretKeyHelp")}
                htmlName="captchaSecretKey"
                value={secretKey}
                onChange={setSecretKey}
              />
            </>
          )}
        </VStack>
      </form>
    </FormCard>
  );
}
