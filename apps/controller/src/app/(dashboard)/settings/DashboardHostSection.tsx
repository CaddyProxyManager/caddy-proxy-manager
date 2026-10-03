"use client";

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/src/components/ui/AppDialog";
import { EnvLabelledField } from "@/src/components/ui/EnvLabelledField";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import {
  FormCard,
  InfoAlert,
  SaveButton,
  StatusAlert,
  WarnAlert,
} from "@/src/components/ui/FormLayout";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import {
  DashboardHostOptionsFields,
  type DashboardHostOptionsData,
} from "@/src/components/proxy-hosts/DashboardHostOptionsFields";
import type { DashboardDnsCheck, DashboardHostSettings } from "@/src/lib/dashboard-host";
import { SKIP_PAGE_SAVE } from "./PageBlocks";

/**
 * Asks first when a change would remove the route the reader is on. The DNS check is inline
 * because forcing HTTPS on a name that does not arrive here only buys a failing ACME order.
 */
export function DashboardHostSection({
  dashboard,
  options,
  dashboardState,
  dashboardFormAction,
  checkDns,
}: {
  dashboard: DashboardHostSettings;
  options: DashboardHostOptionsData | null;
  dashboardState: { success: boolean; message?: string } | null;
  dashboardFormAction: (payload: FormData) => void;
  /** Passed in so the docs site can render this without the actions. */
  checkDns: () => Promise<DashboardDnsCheck>;
}) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(dashboard.enabled);
  const [domain, setDomain] = useState(dashboard.domain);
  const [tls, setTls] = useState(dashboard.tls);
  const [check, setCheck] = useState<DashboardDnsCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  // After mount, or server and browser render different buttons. Compared with the saved domain,
  // since that is what Caddy serves now.
  const [servedThroughProxy, setServedThroughProxy] = useState(false);
  useEffect(() => {
    setServedThroughProxy(
      dashboard.enabled &&
        dashboard.domain.trim().toLowerCase() === window.location.hostname.toLowerCase(),
    );
  }, [dashboard.enabled, dashboard.domain]);

  const losingOwnAccess = servedThroughProxy && !enabled;

  // Against the saved domain, so keystrokes never decide where the server connects.
  const domainIsSaved = domain.trim().toLowerCase() === dashboard.domain.trim().toLowerCase();

  async function runCheck() {
    setChecking(true);
    try {
      const result = await checkDns();
      setCheck(result);
      // The check sets the toggle rather than leaving the operator to act on a warning.
      setTls(result.ok);
    } finally {
      setChecking(false);
    }
  }

  function submit() {
    (document.getElementById("dashboard-host-form") as HTMLFormElement)?.requestSubmit();
  }

  return (
    <>
      <FormCard title={t("dashboardHostTitle")}>
        {/* Off the page bar, which would submit past the confirmation. */}
        <form id="dashboard-host-form" action={dashboardFormAction} {...SKIP_PAGE_SAVE}>
          <VStack gap={3}>
            {dashboardState?.message && (
              <StatusAlert message={dashboardState.message} success={dashboardState.success} />
            )}
            <Switch
              label={t("dashboardEnabledLabel")}
              description={t("dashboardEnabledHelp")}
              htmlName="enabled"
              value={enabled}
              onChange={setEnabled}
            />
            <EnvLabelledField label={t("dashboardDomainLabel")} env={["DASHBOARD_DOMAIN"]}>
              <TextInput
                {...NO_SPELLCHECK}
                label={t("dashboardDomainLabel")}
                description={t("dashboardDomainHelp")}
                htmlName="domain"
                value={domain}
                onChange={setDomain}
                isRequired
              />
            </EnvLabelledField>
            <HStack gap={2} vAlign="end" wrap="wrap">
              <Button
                variant="secondary"
                type="button"
                onClick={runCheck}
                isDisabled={checking || !domainIsSaved || domain.trim() === ""}
                label={checking ? t("dashboardDnsChecking") : t("dashboardDnsCheckLabel")}
              />
            </HStack>
            {!domainIsSaved && (
              <InfoAlert title={t("dashboardCheckNeedsSaveTitle")}>
                {t("dashboardCheckNeedsSaveDescription")}
              </InfoAlert>
            )}
            {check && <DnsCheckResult check={check} />}
            <Switch
              label={t("dashboardTlsLabel")}
              description={t("dashboardTlsHelp")}
              htmlName="tls"
              value={tls}
              onChange={setTls}
            />
            {tls && check && !check.ok && (
              <WarnAlert title={t("dashboardTlsUnverifiedTitle")}>
                {t("dashboardTlsUnverifiedDescription")}
              </WarnAlert>
            )}
            {options && (
              <Collapsible
                defaultIsOpen={false}
                trigger={
                  <Text type="label" size="lg">
                    {t("dashboardProxyOptions")}
                  </Text>
                }
              >
                <VStack gap={3} padding={2}>
                  <Text size="xsm" color="secondary">
                    {t("dashboardProxyOptionsHelp")}
                  </Text>
                  <DashboardHostOptionsFields data={options} />
                </VStack>
              </Collapsible>
            )}
            {/* When cutting the reader's own route, the button asks and the dialog submits. */}
            {losingOwnAccess ? (
              <HStack>
                <Button
                  variant="primary"
                  type="button"
                  onClick={() => setConfirmDisable(true)}
                  label={t("save")}
                />
              </HStack>
            ) : (
              <SaveButton />
            )}
          </VStack>
        </form>
      </FormCard>
      <InfoAlert title={t("dashboardPortEscapeTitle")}>
        {t("dashboardPortEscapeDescription")}
      </InfoAlert>
      <AppDialog
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title={t("dashboardDisableConfirmTitle")}
        submitLabel={t("dashboardDisableConfirmAction")}
        onSubmit={() => {
          setConfirmDisable(false);
          submit();
        }}
      >
        <VStack gap={3}>
          <WarnAlert title={t("dashboardDisableConfirmTitle")}>
            {t("dashboardDisableConfirmBody", { domain: dashboard.domain })}
          </WarnAlert>
          <Text type="body" size="sm" color="secondary">
            {t("dashboardDisableConfirmRecovery")}
          </Text>
        </VStack>
      </AppDialog>
    </>
  );
}

/** The reachability result, in the terms the toggle is decided by. */
function DnsCheckResult({ check }: { check: DashboardDnsCheck }) {
  const t = useTranslations("settings");

  if (check.reason === "reached") {
    return (
      <InfoAlert title={t("dashboardDnsMatchTitle")}>{t("dashboardDnsMatchDescription")}</InfoAlert>
    );
  }
  return (
    <WarnAlert
      title={
        check.reason === "unresolved"
          ? t("dashboardDnsUnresolvedTitle")
          : t("dashboardDnsMismatchTitle")
      }
    >
      {check.reason === "unresolved"
        ? t("dashboardDnsUnresolvedDescription")
        : t("dashboardDnsMismatchDescription", { resolved: check.resolved.join(", ") })}
    </WarnAlert>
  );
}
