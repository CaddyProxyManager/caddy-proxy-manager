"use client";

/**
 * The last setup step, rendered from the settings registry. The Defaults card is hand-written:
 * it lives in the older `general` object, and is here because without an ACME contact the first
 * certificate is issued with nobody to warn about its expiry.
 */
import { Globe } from "lucide-react";
import { type ComponentProps, type FormEvent, useEffect, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Banner } from "@astryxdesign/core/Banner";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { EmailInput } from "@/src/components/ui/EmailInput";
import { EnvTokens } from "@/src/components/ui/EnvTokens";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { AUTOFILL_OFF, NATIVE_REQUIRED } from "@/src/components/ui/native-input-attrs";
import { FormCard, SaveButton, StatusAlert } from "@/src/components/ui/FormLayout";
import { SetupSteps } from "@/src/components/ui/SetupSteps";
import RestartDialog from "@/src/components/setup/RestartDialog";
import type { DomainClaim } from "@/src/lib/dashboard-host/options";
import { useTranslations } from "next-intl";
import { GeneratedPasswordField } from "@/src/components/ui/GeneratedPasswordField";
import { SqliteSetupWarning } from "@/src/components/setup/SqliteSetupWarning";
import { usePageFrame } from "@/src/components/ui/standalone-page";
import { ACCENT_COLORS, DEFAULT_ACCENT_COLOR } from "@/src/lib/branding/accent-colors";

export type SettingField = {
  key: string;
  env: string;
  group: string;
  label: string;
  description: string;
  kind: "string" | "number" | "boolean" | "tristate";
  secret: boolean;
  generatable: boolean;
  /** At most one per group; see the registry's `gate`. */
  gate: boolean;
  value: string | number | boolean | null;
  source: "stored" | "environment" | "default";
};

export type GeneralFields = { defaultDomain: string; acmeEmail: string };

export type DashboardCard = {
  enabled: boolean;
  domain: string;
  fromEnvironment: boolean;
};

export type OAuthPrefill = {
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  autoLink: boolean;
  roleMappingEnabled: boolean;
  groupsClaim: string;
  groupPrefix: string;
  adminGroup: string;
  operatorGroup: string;
  userGroup: string;
  viewerGroup: string;
  defaultRole: string;
  syncGroups: boolean;
};

const OAUTH_ENV = {
  providerName: "OAUTH_PROVIDER_NAME",
  issuer: "OAUTH_ISSUER",
  clientId: "OAUTH_CLIENT_ID",
  clientSecret: "OAUTH_CLIENT_SECRET",
  authorizationUrl: "OAUTH_AUTHORIZATION_URL",
  tokenUrl: "OAUTH_TOKEN_URL",
  userinfoUrl: "OAUTH_USERINFO_URL",
  scopes: "OAUTH_SCOPES",
  autoLink: "OAUTH_ALLOW_AUTO_LINKING",
  roleMappingEnabled: "OAUTH_ROLE_MAPPING",
  groupsClaim: "OAUTH_GROUPS_CLAIM",
  groupPrefix: "OAUTH_GROUP_PREFIX",
  adminGroup: "OAUTH_ADMIN_GROUP",
  operatorGroup: "OAUTH_OPERATOR_GROUP",
  userGroup: "OAUTH_USER_GROUP",
  viewerGroup: "OAUTH_VIEWER_GROUP",
  defaultRole: "OAUTH_DEFAULT_ROLE",
  syncGroups: "OAUTH_SYNC_GROUPS",
} as const satisfies Record<keyof OAuthPrefill, string>;

export type OAuthCard = {
  /** Non-empty means this card has nothing to add. */
  existing: string[];
  fromEnvironment: boolean;
  prefill: OAuthPrefill;
};

export default function SetupSettingsClient({
  fields,
  groups,
  general,
  dashboard,
  domainClaims,
  oauth,
  hasMigrateStep,
  sqliteWarning = false,
}: {
  fields: SettingField[];
  groups: Array<{ id: string; title: string }>;
  general: GeneralFields;
  dashboard: DashboardCard;
  domainClaims: DomainClaim[];
  oauth: OAuthCard;
  hasMigrateStep: boolean;
  sqliteWarning?: boolean;
}) {
  const frame = usePageFrame();
  const t = useTranslations("setup");
  const tSettings = useTranslations("settings");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [finished, setFinished] = useState<{
    next: string;
    restartToken: string;
    dashboardOrigin: string | null;
  } | null>(null);

  const [defaultDomain, setDefaultDomain] = useState(general.defaultDomain);
  const [acmeEmail, setAcmeEmail] = useState(general.acmeEmail);
  const [dashboardEnabled, setDashboardEnabled] = useState(dashboard.enabled);
  const [dashboardDomain, setDashboardDomain] = useState(dashboard.domain);
  const [copyClaim, setCopyClaim] = useState(true);
  const normalizedDashboardDomain = dashboardDomain.trim().toLowerCase();
  const claim = normalizedDashboardDomain
    ? domainClaims.find((host) => host.domains.includes(normalizedDashboardDomain))
    : undefined;
  const [idp, setIdp] = useState<OAuthPrefill>(oauth.prefill);

  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        field.kind === "boolean" || field.gate ? field.value === true : String(field.value ?? ""),
      ]),
    ),
  );

  /**
   * A route handler, not an action: an action re-renders this page, which redirects the moment
   * setup is complete - exactly when the restart still has to be explained.
   */
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/setup/complete", {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      // Not imported from the route: that is a server import waiting to be bundled.
      const body = (await response.json()) as
        | { ok: true; next: string; restartToken: string; dashboardOrigin: string | null }
        | { ok: false; error: string };
      if (!body.ok) {
        setError(body.error);
        return;
      }
      setFinished({
        next: body.next,
        restartToken: body.restartToken,
        dashboardOrigin: body.dashboardOrigin,
      });
    } catch {
      setError(t("errors.settingsSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (finished) {
    const domain = finished.dashboardOrigin ? new URL(finished.dashboardOrigin).host : null;
    return (
      <RestartDialog
        next={finished.next}
        restartToken={finished.restartToken}
        preferredOrigin={finished.dashboardOrigin}
        copy={{
          heading: t("setupCompleteHeading"),
          lead: t("setupCompleteDescription"),
          title: t("setupRestartTitle"),
          description: t("setupRestartDescription"),
          note: domain ? t("restartSignInDashboard", { domain }) : t("restartSignInSetup"),
          manually: t("setupRestartManually"),
          manuallyWithDetail: (detail) => t("setupRestartManuallyWithDetail", { detail }),
        }}
      />
    );
  }

  const isVisible = (field: SettingField) => {
    if (field.gate) return true;
    const gate = fields.find((other) => other.group === field.group && other.gate);
    return !gate || values[gate.key] === true;
  };

  return (
    <Center role={frame.role}>
      <VStack gap={5} padding={5}>
        <SetupSteps stage="settings" hasMigrateStep={hasMigrateStep} />
        {sqliteWarning && <SqliteSetupWarning />}
        <VStack gap={2}>
          <Heading level={frame.titleLevel}>{t("settingsStep.heading")}</Heading>
          <Text color="secondary">{t("databaseSettingsDescription")}</Text>
          {/* The badges' text colours, so each line keys its badges; inline as Text has no hues. */}
          <Text style={{ color: "var(--color-text-purple)" }}>{t("envBadgeLegend")}</Text>
          {(dashboard.fromEnvironment ||
            fields.some((field) => field.source === "environment")) && (
            <Text style={{ color: "var(--color-text-blue)" }}>{t("importedBadgeLegend")}</Text>
          )}
        </VStack>

        <form onSubmit={save}>
          <VStack gap={4}>
            {error && <StatusAlert message={error} success={false} />}

            <FormCard title={tSettings("defaults")}>
              <VStack gap={3}>
                <TextInput
                  startIcon={Globe}
                  // isRequired only marks the field; the native attribute stops an empty post.
                  {...NATIVE_REQUIRED}
                  label={tSettings("defaultDomain")}
                  description={t("defaultDomainHelp")}
                  htmlName="defaultDomain"
                  value={defaultDomain}
                  onChange={setDefaultDomain}
                  isRequired
                  width="100%"
                />
                <EmailInput
                  domain="public"
                  label={tSettings("acmeContactEmail")}
                  description={t("acmeEmailHelp")}
                  htmlName="acmeEmail"
                  value={acmeEmail}
                  onChange={setAcmeEmail}
                  width="100%"
                />
              </VStack>
            </FormCard>

            <FormCard title={tSettings("dashboardHostTitle")}>
              <VStack gap={4}>
                <VStack gap={2}>
                  <Switch
                    label={tSettings("dashboardEnabledLabel")}
                    description={t("dashboardEnabledHelp")}
                    htmlName="dashboardEnabled"
                    value={dashboardEnabled}
                    onChange={setDashboardEnabled}
                  />
                  {dashboardEnabled && <Divider />}
                </VStack>
                {/* Hidden when off, like a gated group: the save reads a missing domain as "leave
                    the dashboard host alone". */}
                {dashboardEnabled && (
                  <LabeledTextInput
                    {...NATIVE_REQUIRED}
                    label={tSettings("dashboardDomainLabel")}
                    env="DASHBOARD_DOMAIN"
                    fromEnvironment={dashboard.fromEnvironment}
                    description={t("dashboardDomainHelp")}
                    htmlName="dashboardDomain"
                    placeholder="cpm.example.com"
                    value={dashboardDomain}
                    onChange={setDashboardDomain}
                    isRequired
                  />
                )}
                {dashboardEnabled && claim && (
                  <ClaimedDomainNotice
                    claim={claim}
                    domain={normalizedDashboardDomain}
                    copy={copyClaim}
                    onCopyChange={setCopyClaim}
                  />
                )}
              </VStack>
            </FormCard>

            {groups.map((group) => {
              const groupFields = fields.filter((field) => field.group === group.id);
              if (groupFields.length === 0) return null;

              const gate = groupFields.find((field) => field.gate);
              const rest = groupFields.filter((field) => !field.gate);
              const change = (key: string) => (next: string | boolean) =>
                setValues((previous) => ({ ...previous, [key]: next }));

              return (
                <FormCard key={group.id} title={group.title}>
                  <VStack gap={4}>
                    {gate && (
                      <GateSwitch
                        field={gate}
                        value={values[gate.key] === true}
                        onChange={change(gate.key)}
                      />
                    )}
                    {/* Hidden, not disabled: an unrendered field posts nothing, so turning
                        analytics off keeps the ClickHouse password rather than clearing it. */}
                    {rest.filter(isVisible).map((field) => (
                      <SettingRow
                        key={field.key}
                        field={field}
                        value={values[field.key]}
                        onChange={change(field.key)}
                      />
                    ))}
                  </VStack>
                </FormCard>
              );
            })}

            <IdentityProviderCard card={oauth} value={idp} onChange={setIdp} />

            <SaveButton label={t("finish")} isDisabled={saving} />
          </VStack>
        </form>
      </VStack>
    </Center>
  );
}

/**
 * The dashboard host wins a domain tie, so the old host would quietly stop answering. Copying is
 * on by default: that host was almost certainly the old way to reach this dashboard.
 */
function ClaimedDomainNotice({
  claim,
  domain,
  copy,
  onCopyChange,
}: {
  claim: DomainClaim;
  domain: string;
  copy: boolean;
  onCopyChange: (next: boolean) => void;
}) {
  const t = useTranslations("setup");
  const onlyDomain = claim.domains.length === 1;
  return (
    <VStack gap={3}>
      <Banner
        status="warning"
        title={t("dashboardClaimTitle", { name: claim.name, domain })}
        description={t("dashboardClaimDescription", { name: claim.name })}
      />
      <input type="hidden" name="dashboardCopyFromHostId" value={claim.id} />
      <Switch
        label={t("dashboardCopyLabel", { name: claim.name })}
        description={
          onlyDomain
            ? t("dashboardCopyHelpDisable", { name: claim.name })
            : t("dashboardCopyHelpRemoveDomain", { name: claim.name, domain })
        }
        htmlName="dashboardCopySettings"
        value={copy}
        onChange={onCopyChange}
      />
    </VStack>
  );
}

function FieldLabel({
  label,
  env,
  fromEnvironment = false,
}: {
  label: string;
  env: string;
  fromEnvironment?: boolean;
}) {
  const t = useTranslations("setup");
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {/* The label type, so it matches the fields that draw their own (Defaults card). */}
      <Text type="label">{label}</Text>
      <EnvTokens names={[env]} />
      {fromEnvironment && <Badge variant="blue" label={t("importedFromEnvironment")} />}
    </HStack>
  );
}

/**
 * Switch's own label only takes a string. Its input id is generated internally, so the visible
 * label learns it after mount to keep a click on the text toggling the switch.
 */
function LabeledSwitch({
  label,
  description,
  env,
  fromEnvironment,
  htmlName,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  env: string;
  fromEnvironment?: boolean;
  htmlName: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputId, setInputId] = useState<string>();
  useEffect(() => setInputId(inputRef.current?.id), []);

  return (
    <HStack gap={3} vAlign="start">
      <Switch
        ref={inputRef}
        label={label}
        isLabelHidden
        htmlName={htmlName}
        value={value}
        onChange={onChange}
      />
      <label htmlFor={inputId} className="cursor-pointer">
        <VStack gap={0}>
          <FieldLabel label={label} env={env} fromEnvironment={fromEnvironment} />
          {description && (
            <Text size="sm" color="secondary">
              {description}
            </Text>
          )}
        </VStack>
      </label>
    </HStack>
  );
}

function LabeledTextInput({
  label,
  env,
  fromEnvironment,
  ...input
}: { env: string; fromEnvironment?: boolean } & Omit<
  ComponentProps<typeof TextInput>,
  "isLabelHidden"
>) {
  return (
    <VStack gap={1}>
      <FieldLabel label={label} env={env} fromEnvironment={fromEnvironment} />
      <TextInput {...input} label={label} isLabelHidden width="100%" />
    </VStack>
  );
}

/** Stored tri-state but posts a definite yes or no: setup is where the choice gets pinned. */
function GateSwitch({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <VStack gap={2}>
      <LabeledSwitch
        label={field.label}
        description={field.description}
        env={field.env}
        fromEnvironment={field.source === "environment"}
        htmlName={field.key}
        value={value}
        onChange={onChange}
      />
      {value && <Divider />}
    </VStack>
  );
}

function SettingRow({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: string | boolean | undefined;
  onChange: (next: string | boolean) => void;
}) {
  const t = useTranslations("setup");
  const tSettings = useTranslations("settings");
  const label = (
    <FieldLabel
      label={field.label}
      env={field.env}
      fromEnvironment={field.source === "environment"}
    />
  );

  // Unset means "let the Security toggle decide", a third value a switch cannot hold.
  if (field.kind === "tristate") {
    return (
      <VStack gap={1}>
        {label}
        <Selector
          label={field.label}
          isLabelHidden
          description={field.description}
          htmlName={field.key}
          value={typeof value === "string" ? value : ""}
          onChange={(next: string) => onChange(next)}
          options={[
            { value: "", label: t("tristateInferred") },
            { value: "true", label: t("tristateRequired") },
            { value: "false", label: t("tristateNotRequired") },
          ]}
        />
      </VStack>
    );
  }

  if (field.kind === "boolean") {
    return (
      <VStack gap={1}>
        {label}
        <Switch
          label={field.description}
          htmlName={field.key}
          value={value === true}
          onChange={(next: boolean) => onChange(next)}
        />
      </VStack>
    );
  }

  // Matched by variable: the registry itself would pull server modules into this bundle.
  if (field.env === "ACCENT_COLOR") {
    return (
      <VStack gap={1}>
        {label}
        <Selector
          label={field.label}
          isLabelHidden
          description={field.description}
          htmlName={field.key}
          value={typeof value === "string" && value !== "" ? value : DEFAULT_ACCENT_COLOR}
          onChange={(next: string) => onChange(next)}
          options={ACCENT_COLORS.map((color) => ({
            value: color,
            label: tSettings(`accentColors.${color}`),
          }))}
        />
      </VStack>
    );
  }

  const description =
    field.secret && field.source !== "default"
      ? t("secretKeepCurrent", { description: field.description })
      : field.description;

  // A licence key or client secret is issued elsewhere; generating one would not work.
  if (field.secret && field.generatable) {
    return (
      <VStack gap={1}>
        {label}
        <GeneratedPasswordField
          label={field.label}
          htmlName={field.key}
          description={description}
          value={typeof value === "string" ? value : ""}
          onChange={(next: string) => onChange(next)}
        />
      </VStack>
    );
  }

  return (
    <VStack gap={1}>
      {label}
      <TextInput
        label={field.label}
        isLabelHidden
        htmlName={field.key}
        type={field.secret ? "password" : "text"}
        description={description}
        value={typeof value === "string" ? value : ""}
        onChange={(next: string) => onChange(next)}
        width="100%"
      />
    </VStack>
  );
}

/**
 * Skipped when the core three are blank. The account step asks about OAuth only when it is the
 * sole way in, so without this the OAUTH_* variables had no home. The rest sit in a disclosure.
 */
function IdentityProviderCard({
  card,
  value,
  onChange,
}: {
  card: OAuthCard;
  value: OAuthPrefill;
  onChange: (next: OAuthPrefill) => void;
}) {
  const t = useTranslations("setup");
  const tSettings = useTranslations("settings");
  const tUsers = useTranslations("users");
  const set =
    <K extends keyof OAuthPrefill>(key: K) =>
    (next: OAuthPrefill[K]) =>
      onChange({ ...value, [key]: next });

  if (card.existing.length > 0) {
    return (
      <FormCard title={t("identityProvider")}>
        <Banner
          status="info"
          title={t("alreadyConfigured", { providers: card.existing.join(", ") })}
          description={t("providerManagementHelp")}
        />
      </FormCard>
    );
  }

  return (
    <FormCard title={t("identityProviderOptional")}>
      <VStack gap={3}>
        <Text size="sm" color="secondary">
          {t("identityProviderDescription")}
        </Text>

        {card.fromEnvironment && (
          <Banner
            status="info"
            title={t("oauthEnvironmentTitle")}
            description={t("oauthEnvironmentDescription")}
          />
        )}

        <LabeledTextInput
          label={tUsers("displayName")}
          env={OAUTH_ENV.providerName}
          description={t("providerNameHelp")}
          htmlName="idpName"
          value={value.providerName}
          onChange={set("providerName")}
        />
        <LabeledTextInput
          label={tSettings("issuerUrl")}
          env={OAUTH_ENV.issuer}
          description={t("issuerUrlHelp")}
          htmlName="idpIssuer"
          value={value.issuer}
          onChange={set("issuer")}
        />
        <LabeledTextInput
          {...AUTOFILL_OFF}
          label={tSettings("clientId")}
          env={OAUTH_ENV.clientId}
          htmlName="idpClientId"
          value={value.clientId}
          onChange={set("clientId")}
        />
        <LabeledTextInput
          {...AUTOFILL_OFF}
          label={tSettings("secretLabel")}
          env={OAUTH_ENV.clientSecret}
          type="password"
          htmlName="idpClientSecret"
          value={value.clientSecret}
          onChange={set("clientSecret")}
        />

        <Collapsible
          defaultIsOpen={false}
          trigger={
            <Text type="label" size="lg">
              {t("moreOptions")}
            </Text>
          }
        >
          <VStack gap={3} padding={2}>
            <Text size="sm" color="secondary">
              {t("manualEndpointsHelp")}
            </Text>
            <LabeledTextInput
              label={tSettings("authorizationUrl")}
              env={OAUTH_ENV.authorizationUrl}
              htmlName="idpAuthorizationUrl"
              value={value.authorizationUrl}
              onChange={set("authorizationUrl")}
            />
            <LabeledTextInput
              label={tSettings("tokenUrl")}
              env={OAUTH_ENV.tokenUrl}
              htmlName="idpTokenUrl"
              value={value.tokenUrl}
              onChange={set("tokenUrl")}
            />
            <LabeledTextInput
              label={tSettings("userinfoUrl")}
              env={OAUTH_ENV.userinfoUrl}
              htmlName="idpUserinfoUrl"
              value={value.userinfoUrl}
              onChange={set("userinfoUrl")}
            />
            <LabeledTextInput
              label={tSettings("scopes")}
              env={OAUTH_ENV.scopes}
              description={t("scopesHelp")}
              htmlName="idpScopes"
              value={value.scopes}
              onChange={set("scopes")}
            />
            <LabeledSwitch
              label={t("oauthAutoLinkLabel")}
              env={OAUTH_ENV.autoLink}
              description={t("oauthAutoLinkHelp")}
              htmlName="idpAutoLink"
              value={value.autoLink}
              onChange={set("autoLink")}
            />

            <Divider />

            <LabeledSwitch
              label={t("groupRoleMappingLabel")}
              env={OAUTH_ENV.roleMappingEnabled}
              description={t("groupRoleMappingHelp")}
              htmlName="idpRoleMapping"
              value={value.roleMappingEnabled}
              onChange={set("roleMappingEnabled")}
            />
            {value.roleMappingEnabled && (
              <>
                <LabeledTextInput
                  label={tSettings("groupsClaim")}
                  env={OAUTH_ENV.groupsClaim}
                  description={t("groupsClaimHelp")}
                  htmlName="idpGroupsClaim"
                  value={value.groupsClaim}
                  onChange={set("groupsClaim")}
                />
                <LabeledTextInput
                  label={tSettings("groupPrefix")}
                  env={OAUTH_ENV.groupPrefix}
                  description={t("groupPrefixHelp")}
                  htmlName="idpGroupPrefix"
                  value={value.groupPrefix}
                  onChange={set("groupPrefix")}
                />
                <LabeledTextInput
                  label={t("adminGroup")}
                  env={OAUTH_ENV.adminGroup}
                  htmlName="idpAdminGroup"
                  value={value.adminGroup}
                  onChange={set("adminGroup")}
                />
                <LabeledTextInput
                  label={t("operatorGroup")}
                  env={OAUTH_ENV.operatorGroup}
                  htmlName="idpOperatorGroup"
                  value={value.operatorGroup}
                  onChange={set("operatorGroup")}
                />
                <LabeledTextInput
                  label={t("userGroup")}
                  env={OAUTH_ENV.userGroup}
                  htmlName="idpUserGroup"
                  value={value.userGroup}
                  onChange={set("userGroup")}
                />
                <LabeledTextInput
                  label={t("viewerGroup")}
                  env={OAUTH_ENV.viewerGroup}
                  htmlName="idpViewerGroup"
                  value={value.viewerGroup}
                  onChange={set("viewerGroup")}
                />
                <LabeledSwitch
                  label={t("groupSyncLabel")}
                  env={OAUTH_ENV.syncGroups}
                  htmlName="idpSyncGroups"
                  value={value.syncGroups}
                  onChange={set("syncGroups")}
                />
              </>
            )}
            <VStack gap={1}>
              <FieldLabel label={t("defaultRoleLabel")} env={OAUTH_ENV.defaultRole} />
              <Selector
                label={t("defaultRoleLabel")}
                isLabelHidden
                htmlName="idpDefaultRole"
                value={value.defaultRole}
                onChange={(next: string) => set("defaultRole")(next)}
                options={[
                  { value: "viewer", label: tUsers("roles.viewer") },
                  { value: "user", label: tUsers("roles.user") },
                  { value: "admin", label: tUsers("roles.admin") },
                ]}
              />
            </VStack>
          </VStack>
        </Collapsible>
      </VStack>
    </FormCard>
  );
}
