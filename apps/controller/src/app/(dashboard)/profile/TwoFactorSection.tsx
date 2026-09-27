"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { renderSVG } from "uqr";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  AUTOFILL_CURRENT_PASSWORD,
  AUTOFILL_ONE_TIME_CODE,
  NO_SPELLCHECK,
} from "@/components/ui/native-input-attrs";
import { authClient } from "@/src/lib/auth-client";
import { twoFactorError } from "@/src/lib/two-factor-error";

type Flow =
  | { kind: "closed" }
  | { kind: "enable-password" }
  | { kind: "enable-scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] }
  | { kind: "regenerate" }
  | { kind: "disable" };

/** The secret in an otpauth URI, for typing into an app that can't scan. */
function secretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

function downloadCodes(codes: string[], filename: string) {
  const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Every step re-asks for the password: an open session must not be enough to change 2FA. */
export function TwoFactorSection({
  enabled,
  hasPassword,
  locked,
}: {
  enabled: boolean;
  /** 2FA guards the password; an account without one signs in through its identity provider. */
  hasPassword: boolean;
  /** The shared demo account, which every visitor signs in to. */
  locked: boolean;
}) {
  const t = useTranslations("profile.twoFactor");
  const tApi = useTranslations("auth.apiErrors");
  const router = useRouter();
  const [flow, setFlow] = useState<Flow>({ kind: "closed" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    // Only once the codes are put away: the refresh navigates off codes shown only once.
    if (flow.kind === "codes") router.refresh();
    setFlow({ kind: "closed" });
    setPassword("");
    setCode("");
    setError(null);
  };

  const failed = (fallback: string, message?: string) => {
    setError(message || fallback);
    setBusy(false);
  };

  const startEnable = async () => {
    setBusy(true);
    setError(null);
    const { data, error: refused } = await authClient.twoFactor.enable({ password });
    if (refused || !data) return failed(t("passwordRejected"));
    setPassword("");
    setBusy(false);
    setFlow({ kind: "enable-scan", totpURI: data.totpURI, backupCodes: data.backupCodes });
  };

  const confirmEnable = async (backupCodes: string[]) => {
    setBusy(true);
    setError(null);
    const { error: refused } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
    if (refused) return failed(tApi(twoFactorError(refused).key));
    setCode("");
    setBusy(false);
    setFlow({ kind: "codes", backupCodes });
  };

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    const { data, error: refused } = await authClient.twoFactor.generateBackupCodes({ password });
    if (refused || !data) return failed(t("passwordRejected"));
    setPassword("");
    setBusy(false);
    setFlow({ kind: "codes", backupCodes: data.backupCodes });
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    const { error: refused } = await authClient.twoFactor.disable({ password });
    if (refused) return failed(t("passwordRejected"));
    setBusy(false);
    close();
    router.refresh();
  };

  if (!hasPassword) {
    return (
      <Text type="body" size="sm" color="secondary">
        {t("noPassword")}
      </Text>
    );
  }
  if (locked) {
    return (
      <Text type="body" size="sm" color="secondary">
        {t("demoLocked")}
      </Text>
    );
  }

  const passwordField = (
    <TextInput
      {...AUTOFILL_CURRENT_PASSWORD}
      label={t("password")}
      type="password"
      value={password}
      onChange={setPassword}
      isRequired
      hasAutoFocus
      width="100%"
    />
  );
  const errorBanner = error && (
    <Banner status="error" title={t("errorTitle")} description={error} />
  );

  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <StatusDot
          variant={enabled ? "success" : "neutral"}
          label={enabled ? t("statusOn") : t("statusOff")}
        />
        <Text type="body" size="sm" weight="semibold">
          {enabled ? t("statusOn") : t("statusOff")}
        </Text>
      </HStack>
      <Text type="body" size="sm" color="secondary">
        {enabled ? t("descriptionOn") : t("descriptionOff")}
      </Text>
      <HStack gap={2} wrap="wrap">
        {enabled ? (
          <>
            <Button
              variant="secondary"
              label={t("newBackupCodes")}
              onClick={() => setFlow({ kind: "regenerate" })}
            />
            <Button
              variant="secondary"
              label={t("turnOff")}
              onClick={() => setFlow({ kind: "disable" })}
            />
          </>
        ) : (
          <Button label={t("turnOn")} onClick={() => setFlow({ kind: "enable-password" })} />
        )}
      </HStack>

      <AppDialog
        open={flow.kind === "enable-password"}
        onClose={close}
        title={t("turnOn")}
        maxWidth="sm"
        submitLabel={t("continue")}
        onSubmit={startEnable}
        isSubmitting={busy}
        isSubmitDisabled={!password}
      >
        <VStack gap={3}>
          {errorBanner}
          <Text type="body" size="sm">
            {t("enableIntro")}
          </Text>
          {passwordField}
        </VStack>
      </AppDialog>

      {flow.kind === "enable-scan" && (
        <AppDialog
          open
          onClose={close}
          title={t("scanTitle")}
          maxWidth="sm"
          submitLabel={t("confirm")}
          onSubmit={() => confirmEnable(flow.backupCodes)}
          isSubmitting={busy}
          isSubmitDisabled={!code.trim()}
        >
          <VStack gap={3} hAlign="center">
            {errorBanner}
            <Text type="body" size="sm">
              {t("scanHelp")}
            </Text>
            {/* White-backed on purpose: scanners read dark-on-light, whatever the theme. */}
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(flow.totpURI))}`}
              alt={t("qrAlt")}
              width={200}
              height={200}
            />
            <Text type="body" size="xsm" color="secondary">
              {t("manualEntry")}
            </Text>
            <CodeBlock code={secretOf(flow.totpURI)} size="sm" width="100%" />
            <TextInput
              {...NO_SPELLCHECK}
              {...AUTOFILL_ONE_TIME_CODE}
              label={t("code")}
              value={code}
              onChange={setCode}
              isRequired
              width="100%"
            />
          </VStack>
        </AppDialog>
      )}

      {flow.kind === "codes" && (
        <AppDialog
          open
          onClose={close}
          title={t("codesTitle")}
          maxWidth="sm"
          submitLabel={t("done")}
          onSubmit={close}
        >
          <VStack gap={3}>
            <Banner status="warning" title={t("codesWarningTitle")} description={t("codesHelp")} />
            <CodeBlock code={flow.backupCodes.join("\n")} size="sm" width="100%" />
            <HStack>
              <Button
                variant="secondary"
                label={t("download")}
                onClick={() => downloadCodes(flow.backupCodes, t("downloadFilename"))}
              />
            </HStack>
          </VStack>
        </AppDialog>
      )}

      <AppDialog
        open={flow.kind === "regenerate"}
        onClose={close}
        title={t("newBackupCodes")}
        maxWidth="sm"
        submitLabel={t("continue")}
        onSubmit={regenerate}
        isSubmitting={busy}
        isSubmitDisabled={!password}
      >
        <VStack gap={3}>
          {errorBanner}
          <Text type="body" size="sm">
            {t("regenerateHelp")}
          </Text>
          {passwordField}
        </VStack>
      </AppDialog>

      <AppDialog
        open={flow.kind === "disable"}
        onClose={close}
        title={t("turnOff")}
        maxWidth="sm"
        submitLabel={t("turnOff")}
        onSubmit={disable}
        isSubmitting={busy}
        isSubmitDisabled={!password}
      >
        <VStack gap={3}>
          {errorBanner}
          <Text type="body" size="sm">
            {t("disableHelp")}
          </Text>
          {passwordField}
        </VStack>
      </AppDialog>
    </VStack>
  );
}
