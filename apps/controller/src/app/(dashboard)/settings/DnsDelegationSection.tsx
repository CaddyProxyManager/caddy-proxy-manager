"use client";

import { Globe, Link } from "lucide-react";
import { useActionState, useCallback, useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useTranslations } from "next-intl";
import { FormCard, InfoAlert, StatusAlert, WarnAlert } from "@/src/components/ui/FormLayout";
import { AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { useTableDensity } from "@/components/ui/TableDensity";
import type { DnsProviderApiStatus, DnsProviderDefinition } from "@/src/lib/dns/providers";
import {
  ACMEDNS_PROVIDER,
  challengeRecordName,
  expectedDelegationTarget,
} from "@/src/lib/dns/challenge-delegation";
import type { DelegationCheck } from "@/src/lib/dns/delegation-check";
import { checkDnsDelegationsAction, registerAcmeDnsAccountAction } from "./actions";
import { SKIP_PAGE_SAVE } from "./PageBlocks";

type Row = {
  id: string;
  domain: string;
  record: string;
  target: string | null;
  provider: string | null;
};

function CheckStatus({ check, checking }: { check?: DelegationCheck; checking: boolean }) {
  const t = useTranslations("settings.dnsDelegation");
  const tCommon = useTranslations("common");
  if (checking && !check) {
    return (
      <HStack gap={2} vAlign="center">
        <StatusDot variant="neutral" label={tCommon("checking")} />
        <Text type="body" size="xsm" color="secondary">
          {tCommon("checking")}
        </Text>
      </HStack>
    );
  }
  if (!check || check.status === "none") {
    return (
      <HStack gap={2} vAlign="center">
        <StatusDot variant="neutral" label={t("statusNone")} />
        <Text type="body" size="xsm" color="secondary">
          {t("statusNone")}
        </Text>
      </HStack>
    );
  }
  const text =
    check.status === "ok"
      ? t("statusOk")
      : check.status === "missing"
        ? t("statusMissing")
        : t("statusMismatch", { found: check.found.join(", ") });
  return (
    <HStack gap={2} vAlign="center">
      <StatusDot variant={check.status === "ok" ? "success" : "warning"} label={text} />
      <Text type="body" size="xsm" color="secondary">
        {text}
      </Text>
    </HStack>
  );
}

export function DnsDelegationSection({
  dnsProvider,
  dnsProviderDefinitions,
  configuredProviders,
  formAction,
  isProviderAvailable,
}: {
  dnsProvider: DnsProviderApiStatus | null;
  dnsProviderDefinitions: DnsProviderDefinition[];
  configuredProviders: string[];
  formAction: (payload: FormData) => void;
  isProviderAvailable: (name: string) => boolean;
}) {
  const t = useTranslations("settings.dnsDelegation");
  const tCommon = useTranslations("common");
  const density = useTableDensity();
  const [registerState, registerFormAction, registering] = useActionState(
    registerAcmeDnsAccountAction,
    null,
  );
  const [provider, setProvider] = useState("default");
  const [domain, setDomain] = useState("");
  const [target, setTarget] = useState("");
  const [registerDomain, setRegisterDomain] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [checks, setChecks] = useState<Map<string, DelegationCheck>>(new Map());
  const [checking, setChecking] = useState(false);

  const delegations = dnsProvider?.delegations ?? [];
  const accounts = dnsProvider?.acmeDnsAccounts ?? {};
  const displayName = (name: string) =>
    dnsProviderDefinitions.find((p) => p.name === name)?.displayName ?? name;

  const rows: Row[] = delegations.map((delegation) => ({
    id: delegation.domain,
    domain: delegation.domain,
    record: challengeRecordName(delegation.domain),
    target: expectedDelegationTarget(delegation, accounts),
    provider: delegation.provider ?? null,
  }));
  const delegationKey = rows.map((row) => `${row.domain}=${row.target ?? ""}`).join(",");

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const results = await checkDnsDelegationsAction();
      setChecks(new Map(results.map((check) => [check.domain, check])));
    } finally {
      setChecking(false);
    }
  }, []);

  // Re-run when the rows change, so a new delegation is checked without a click.
  useEffect(() => {
    if (delegationKey) void runCheck();
  }, [delegationKey, runCheck]);

  const failing = [...checks.values()].filter(
    (check) => check.status === "missing" || check.status === "mismatch",
  );

  const columns: TableColumn<Row>[] = [
    {
      key: "domain",
      header: t("columnDomain"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="code" size="sm" weight="medium">
          {row.domain}
        </Text>
      ),
    },
    {
      key: "cname",
      header: t("columnCname"),
      width: proportional(2),
      renderCell: (row) =>
        row.target ? (
          <Text type="code" size="xsm">
            {t("cnameRecord", { record: row.record, target: row.target })}
          </Text>
        ) : (
          <Text type="body" size="xsm" color="secondary">
            {t("noCnameNeeded")}
          </Text>
        ),
    },
    {
      key: "provider",
      header: tCommon("provider"),
      width: pixel(140),
      renderCell: (row) => (
        <Text type="body" size="sm">
          {row.provider ? displayName(row.provider) : t("providerDefault")}
        </Text>
      ),
    },
    {
      key: "status",
      header: t("columnStatus"),
      width: pixel(200),
      renderCell: (row) => <CheckStatus check={checks.get(row.domain)} checking={checking} />,
    },
    {
      key: "__remove",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(100),
      align: "end",
      resizable: false,
      renderCell: (row) => (
        <form action={formAction}>
          <input type="hidden" name="action" value="delegation-remove" />
          <input type="hidden" name="domain" value={row.domain} />
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            label={tCommon("remove")}
            tooltip={t("removeNamed", { domain: row.domain })}
          />
        </form>
      ),
    },
  ];

  const providerOptions = [
    { value: "default", label: t("providerDefault") },
    ...configuredProviders.map((name) => ({ value: name, label: displayName(name) })),
  ];
  const acmeDnsAvailable = isProviderAvailable(ACMEDNS_PROVIDER);

  return (
    <>
      <FormCard title={t("title")}>
        <VStack gap={3}>
          <Text type="body" size="sm" color="secondary">
            {t("description")}
          </Text>
          {rows.length === 0 ? (
            <Text type="body" size="sm" color="secondary">
              {t("empty")}
            </Text>
          ) : (
            <>
              <Table data={rows} columns={columns} idKey="id" density={density} hasHover />
              <HStack gap={2} justify="end">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  label={checking ? tCommon("checking") : tCommon("checkAgain")}
                  isDisabled={checking}
                  onClick={() => void runCheck()}
                />
              </HStack>
            </>
          )}
          {failing.length > 0 && (
            <WarnAlert title={t("cnameMissingTitle")}>{t("cnameMissingDescription")}</WarnAlert>
          )}
        </VStack>
      </FormCard>

      <FormCard
        title={t("addTitle")}
        footer={
          <Button
            type="submit"
            form="dns-delegation-form"
            variant="primary"
            size="sm"
            label={t("add")}
          />
        }
      >
        <form id="dns-delegation-form" action={formAction}>
          <VStack gap={3}>
            <input type="hidden" name="action" value="delegation-save" />
            <TextInput
              startIcon={Globe}
              {...AUTOFILL_OFF}
              label={t("columnDomain")}
              description={t("domainHelp")}
              htmlName="domain"
              value={domain}
              onChange={setDomain}
              placeholder={t("domainPlaceholder")}
              isRequired
            />
            <TextInput
              startIcon={Globe}
              {...AUTOFILL_OFF}
              label={t("targetLabel")}
              description={t("targetHelp")}
              htmlName="target"
              value={target}
              onChange={setTarget}
              placeholder={t("targetPlaceholder")}
              isOptional
            />
            <Selector
              label={tCommon("provider")}
              description={t("providerHelp")}
              htmlName="delegationProvider"
              options={providerOptions}
              value={provider}
              onChange={setProvider}
            />
            <Text type="body" size="xsm" color="secondary">
              {t("rfc2136Hint")}
            </Text>
          </VStack>
        </form>
      </FormCard>

      <FormCard
        title={t("registerTitle")}
        footer={
          <Button
            type="submit"
            form="acme-dns-register-form"
            variant="primary"
            size="sm"
            label={registering ? t("registering") : t("register")}
            isDisabled={registering || !acmeDnsAvailable}
          />
        }
      >
        {/* Off the page bar: it registers an account on another server. */}
        <form id="acme-dns-register-form" action={registerFormAction} {...SKIP_PAGE_SAVE}>
          <VStack gap={3}>
            <Text type="body" size="sm" color="secondary">
              {t("registerDescription")}
            </Text>
            {!acmeDnsAvailable && (
              <WarnAlert title={t("acmeDnsModuleDisabledTitle")}>
                {t("acmeDnsModuleDisabledDescription")}
              </WarnAlert>
            )}
            {registerState?.message && !registerState.cname && (
              <StatusAlert message={registerState.message} success={registerState.success} />
            )}
            {registerState?.success && registerState.cname && (
              <InfoAlert title={t("registeredTitle")}>
                <VStack gap={2}>
                  <Text type="body" size="sm">
                    {t("registeredDescription")}
                  </Text>
                  <Code>
                    {t("cnameRecord", {
                      record: registerState.cname.name,
                      target: registerState.cname.target,
                    })}
                  </Code>
                </VStack>
              </InfoAlert>
            )}
            <TextInput
              startIcon={Globe}
              {...AUTOFILL_OFF}
              label={t("columnDomain")}
              description={t("registerDomainHelp")}
              htmlName="domain"
              value={registerDomain}
              onChange={setRegisterDomain}
              placeholder={t("domainPlaceholder")}
              isRequired
            />
            {/* The public server is a placeholder only: which server holds the account is the operator's call. */}
            <TextInput
              startIcon={Link}
              {...AUTOFILL_OFF}
              label={t("serverUrlLabel")}
              description={t("serverUrlHelp")}
              htmlName="serverUrl"
              value={serverUrl}
              onChange={setServerUrl}
              placeholder={t("serverUrlPlaceholder")}
              isRequired
            />
          </VStack>
        </form>
      </FormCard>
    </>
  );
}
