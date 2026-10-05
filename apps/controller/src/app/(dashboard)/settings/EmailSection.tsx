"use client";

import { CalendarDays, EthernetPort, Globe, KeyRound, Mail, User } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@astryxdesign/core/Button";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useFormatter, useTranslations } from "next-intl";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { TIMESTAMP_STYLES, UtcTooltip } from "@/components/ui/Timestamp";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { EmailInput } from "@/src/components/ui/EmailInput";
import { EnvLabelledField } from "@/src/components/ui/EnvLabelledField";
import { FormCard, InfoAlert, StatusAlert, WarnAlert } from "@/src/components/ui/FormLayout";
import type { EmailSettingsView } from "@/src/lib/email/view";
import { SMTP_SECURITY_MODES, type SmtpSecurity } from "@/src/lib/email/security";
import { sendTestEmailAction, sendTestNotificationAction } from "./actions";
import { SKIP_PAGE_SAVE } from "./PageBlocks";

type FormState = { success: boolean; message?: string } | null;

/** Port each mode is usually served on, so switching the mode can bring the port along. */
const USUAL_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, none: 25 };

export function EmailServerSection({
  email,
  state,
  formAction,
}: {
  email: EmailSettingsView;
  state: FormState;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.email");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  const [enabled, setEnabled] = useState(email.enabled);
  const [host, setHost] = useState(email.host);
  const [port, setPort] = useState(email.port);
  const [security, setSecurity] = useState<SmtpSecurity>(email.security);
  const [username, setUsername] = useState(email.username);
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState(email.from);

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          {email.status === "incomplete" && (
            <WarnAlert title={t("incompleteTitle")}>{t("incompleteBody")}</WarnAlert>
          )}
          <EnvLabelledField
            label={tSettings("registry.smtp_enabled.label")}
            env={["SMTP_ENABLED"]}
            description={t("enabledHelp")}
            layout="inline"
          >
            <Switch
              label={tSettings("registry.smtp_enabled.label")}
              htmlName="smtpEnabled"
              value={enabled}
              onChange={setEnabled}
            />
          </EnvLabelledField>
          <EnvLabelledField label={tSettings("registry.smtp_host.label")} env={["SMTP_HOST"]}>
            <TextInput
              startIcon={Globe}
              {...AUTOFILL_OFF}
              label={tSettings("registry.smtp_host.label")}
              description={tSettings("registry.smtp_host.description")}
              htmlName="smtpHost"
              value={host}
              onChange={setHost}
              placeholder="smtp.example.com"
            />
          </EnvLabelledField>
          <EnvLabelledField label={t("security")} env={["SMTP_SECURITY"]}>
            <Selector
              label={t("security")}
              description={t("securityHelp")}
              htmlName="smtpSecurity"
              options={SMTP_SECURITY_MODES.map((value) => ({
                value,
                label: t(`securityModes.${value}`),
              }))}
              value={security}
              onChange={(value) => {
                const next = value as SmtpSecurity;
                // Only while the port is still the old mode's usual one: a custom port stays.
                if (port === USUAL_PORT[security]) setPort(USUAL_PORT[next]);
                setSecurity(next);
              }}
            />
          </EnvLabelledField>
          <EnvLabelledField label={tCommon("port")} env={["SMTP_PORT"]}>
            <NumberInput
              startIcon={EthernetPort}
              hasNumberSteppers
              label={tCommon("port")}
              htmlName="smtpPort"
              value={port}
              onChange={setPort}
              isIntegerOnly
              min={1}
              max={65_535}
            />
          </EnvLabelledField>
          <EnvLabelledField label={tCommon("username")} env={["SMTP_USERNAME"]}>
            <TextInput
              startIcon={User}
              {...AUTOFILL_OFF}
              label={tCommon("username")}
              description={tSettings("registry.smtp_username.description")}
              isOptional
              htmlName="smtpUsername"
              value={username}
              onChange={setUsername}
            />
          </EnvLabelledField>
          <EnvLabelledField label={tCommon("password")} env={["SMTP_PASSWORD"]}>
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_NEW_PASSWORD}
              label={tCommon("password")}
              type="password"
              isOptional
              description={
                email.hasPassword ? tSettings("clickhousePasswordStored") : t("passwordHelp")
              }
              htmlName="smtpPassword"
              value={password}
              onChange={setPassword}
            />
          </EnvLabelledField>
          <EnvLabelledField label={tSettings("registry.smtp_from.label")} env={["SMTP_FROM"]}>
            <EmailInput
              label={tSettings("registry.smtp_from.label")}
              description={tSettings("registry.smtp_from.description")}
              htmlName="smtpFrom"
              value={from}
              onChange={setFrom}
              domain="public"
              placeholder="proxy@example.com"
            />
          </EnvLabelledField>
        </VStack>
      </form>
      <TestEmailForm ready={email.status === "ready"} />
    </FormCard>
  );
}

/** Its own form, left out of the page save: it sends with what is saved, not what is typed. */
function TestEmailForm({ ready }: { ready: boolean }) {
  const t = useTranslations("settings.email");
  const [recipient, setRecipient] = useState("");
  const [result, setResult] = useState<FormState>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      {...SKIP_PAGE_SAVE}
      onSubmit={(event) => {
        event.preventDefault();
        setResult(null);
        startTransition(async () => setResult(await sendTestEmailAction(recipient)));
      }}
    >
      <VStack gap={2}>
        <HStack gap={2} vAlign="end" wrap="wrap">
          <EmailInput
            label={t("testRecipient")}
            description={ready ? t("testHelp") : t("testNeedsSave")}
            value={recipient}
            onChange={setRecipient}
            placeholder={t("testRecipientPlaceholder")}
            isDisabled={!ready || pending}
          />
          <Button
            type="submit"
            variant="secondary"
            label={pending ? t("testSending") : t("testSend")}
            isLoading={pending}
            isDisabled={!ready || pending}
          />
        </HStack>
        {result?.message && <StatusAlert message={result.message} success={result.success} />}
      </VStack>
    </form>
  );
}

/**
 * Recipients and the certificate alerts, which keep their own form and action, then the delivery
 * status; the per-event switches are a registry block the caller renders below.
 */
export function NotificationsSection({
  email,
  state,
  formAction,
}: {
  email: EmailSettingsView;
  state: FormState;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.email");
  const tSettings = useTranslations("settings");
  const format = useFormatter();
  const [days, setDays] = useState(email.alertDays);
  const [recipients, setRecipients] = useState(email.alertRecipients);
  const { notifications } = email;

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          {email.status !== "ready" && (
            <InfoAlert title={t("alertsNeedEmailTitle")}>{t("alertsNeedEmailBody")}</InfoAlert>
          )}
          <EnvLabelledField label={t("alertRecipients")} env={["EMAIL_ALERT_RECIPIENTS"]}>
            <TextInput
              startIcon={Mail}
              {...AUTOFILL_OFF}
              label={t("alertRecipients")}
              description={t("alertRecipientsHelp")}
              isOptional
              htmlName="alertRecipients"
              value={recipients}
              onChange={setRecipients}
              placeholder={t("alertRecipientsPlaceholder")}
            />
          </EnvLabelledField>
          <EnvLabelledField label={t("alertDays")} env={["CERTIFICATE_EXPIRY_ALERT_DAYS"]}>
            <NumberInput
              startIcon={CalendarDays}
              hasNumberSteppers
              units={tSettings("units.days")}
              label={t("alertDays")}
              description={t("alertDaysHelp")}
              htmlName="alertDays"
              value={days}
              onChange={setDays}
              isIntegerOnly
              min={0}
              max={90}
            />
          </EnvLabelledField>
          {email.alertsCheckedAt ? (
            <UtcTooltip value={email.alertsCheckedAt}>
              <Text size="sm" color="secondary">
                {t("alertsLastChecked", {
                  when: format.dateTime(new Date(email.alertsCheckedAt), TIMESTAMP_STYLES.dateTime),
                })}
              </Text>
            </UtcTooltip>
          ) : (
            <Text size="sm" color="secondary">
              {t("alertsNeverChecked")}
            </Text>
          )}
          {email.alertsError && (
            <WarnAlert title={t("alertsFailed", { error: email.alertsError })} />
          )}
          {notifications.lastSentAt ? (
            <UtcTooltip value={notifications.lastSentAt}>
              <Text size="sm" color="secondary">
                {t("notificationsLastSent", {
                  when: format.dateTime(
                    new Date(notifications.lastSentAt),
                    TIMESTAMP_STYLES.dateTime,
                  ),
                })}
              </Text>
            </UtcTooltip>
          ) : (
            <Text size="sm" color="secondary">
              {t("notificationsNeverSent")}
            </Text>
          )}
          {notifications.pending > 0 && (
            <Text size="sm" color="secondary">
              {t("notificationsPending", { count: notifications.pending })}
            </Text>
          )}
          {notifications.lastError && (
            <WarnAlert title={t("notificationsFailed", { error: notifications.lastError })} />
          )}
          {notifications.lastErrorCode === "noRecipients" && (
            <WarnAlert title={t("notificationsNoRecipients")} />
          )}
        </VStack>
      </form>
      <TestNotificationForm ready={email.status === "ready"} />
    </FormCard>
  );
}

/** Its own form, left out of the page save, like the test email. */
function TestNotificationForm({ ready }: { ready: boolean }) {
  const t = useTranslations("settings.email");
  const [result, setResult] = useState<FormState>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      {...SKIP_PAGE_SAVE}
      onSubmit={(event) => {
        event.preventDefault();
        setResult(null);
        startTransition(async () => setResult(await sendTestNotificationAction()));
      }}
    >
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button
            type="submit"
            variant="secondary"
            label={pending ? t("testSending") : t("testNotification")}
            isLoading={pending}
            isDisabled={!ready || pending}
          />
          <Text size="sm" color="secondary">
            {ready ? t("testNotificationHelp") : t("testNeedsSave")}
          </Text>
        </HStack>
        {result?.message && <StatusAlert message={result.message} success={result.success} />}
      </VStack>
    </form>
  );
}
