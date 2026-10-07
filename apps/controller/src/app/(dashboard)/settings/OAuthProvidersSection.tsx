"use client";

import { useState, useCallback, useContext, useMemo } from "react";
import { KeyRound, Link, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import { AUTOFILL_NEW_PASSWORD } from "@/components/ui/native-input-attrs";
import { useTranslations } from "next-intl";
import {
  oauthCallbackUrl,
  oidcBackchannelLogoutUrl,
  withOAuthClientSecretRotation,
  type OAuthProviderView,
} from "@/src/lib/auth/oidc/provider-view";
import {
  GroupMappingFields,
  MadeRolesContext,
  madeRoleGroupsOf,
  roleGroupsInput,
} from "./GroupMappingFields";
import {
  createOAuthProviderAction,
  setPrimaryOAuthProviderAction,
  updateOAuthProviderAction,
  deleteOAuthProviderAction,
} from "./actions";
import {
  createSamlProviderAction,
  deleteSamlProviderAction,
  updateSamlProviderAction,
} from "./saml-actions";
import type { SamlProvider } from "@/src/lib/models/saml-providers";
import { unwrap } from "@/src/lib/errors/action-result";
import { SAML_PROVIDER_TYPE, samlAcsUrl } from "@/src/lib/auth/saml/urls";
import {
  type SamlForm,
  SamlProviderFields,
  emptySamlForm,
  samlFormOf,
  samlInputOf,
} from "./SamlProviderFields";

interface OAuthProvidersSectionProps {
  initialProviders: OAuthProviderView[];
  /** Listed with the OIDC providers: to someone signing in, both are a button. */
  initialSamlProviders?: SamlProvider[];
  /** The provider offered first on the sign-in screen, or null for alphabetical order. */
  initialPrimaryProviderId?: string | null;
  baseUrl: string;
  /** True when AUTH_DISABLE_LOCAL_USERS=true - SSO is the only way in. */
  localUsersDisabled?: boolean;
}

type FormData = {
  name: string;
  type: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  autoLink: boolean;
  groupsClaim: string;
  groupPrefix: string;
  roleMappingEnabled: boolean;
  adminGroup: string;
  operatorGroup: string;
  userGroup: string;
  viewerGroup: string;
  defaultRole: string;
  madeRoleGroups: Record<string, string>;
  syncGroups: boolean;
};

const emptyForm: FormData = {
  name: "",
  type: "oidc",
  clientId: "",
  clientSecret: "",
  issuer: "",
  authorizationUrl: "",
  tokenUrl: "",
  userinfoUrl: "",
  scopes: "openid email profile",
  autoLink: false,
  groupsClaim: "groups",
  groupPrefix: "",
  roleMappingEnabled: false,
  adminGroup: "",
  operatorGroup: "",
  userGroup: "",
  viewerGroup: "",
  defaultRole: "user",
  madeRoleGroups: {},
  syncGroups: false,
};

/** One row of the list, whichever protocol is behind it. */
type ListedProvider =
  | { kind: "oidc"; provider: OAuthProviderView }
  | { kind: "saml"; provider: SamlProvider };

export default function OAuthProvidersSection({
  initialProviders,
  initialSamlProviders = [],
  initialPrimaryProviderId = null,
  baseUrl,
  localUsersDisabled = false,
}: OAuthProvidersSectionProps) {
  const t = useTranslations("settings");
  const made = useContext(MadeRolesContext);
  const tCommon = useTranslations("common");
  const [providers, setProviders] = useState(initialProviders);
  const [samlProviders, setSamlProviders] = useState(initialSamlProviders);
  const [editingSaml, setEditingSaml] = useState<SamlProvider | null>(null);
  const [samlForm, setSamlForm] = useState<SamlForm>(emptySamlForm);
  const [deleteSamlConfirm, setDeleteSamlConfirm] = useState<SamlProvider | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<OAuthProviderView | null>(null);
  const [rotateClientSecret, setRotateClientSecret] = useState(false);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<OAuthProviderView | null>(null);
  // Held locally so the badge moves on click rather than on reload.
  const [primaryId, setPrimaryId] = useState<string | null>(initialPrimaryProviderId);

  const callbackUrl = useCallback(
    (providerId: string) => oauthCallbackUrl(baseUrl, providerId),
    [baseUrl],
  );

  // One URL for every provider: the logout token's issuer picks the provider to verify against.
  const backchannelLogoutUrl = useMemo(() => oidcBackchannelLogoutUrl(baseUrl), [baseUrl]);

  function closeDialog() {
    // Drops a typed replacement secret from client memory.
    setDialogOpen(false);
    setEditingProvider(null);
    setEditingSaml(null);
    setRotateClientSecret(false);
    setForm(emptyForm);
    setSamlForm(emptySamlForm);
    setError(null);
  }

  function openSamlEditDialog(provider: SamlProvider) {
    setEditingProvider(null);
    setEditingSaml(provider);
    setForm({ ...emptyForm, name: provider.name, type: SAML_PROVIDER_TYPE });
    setSamlForm(samlFormOf(provider));
    setError(null);
    setDialogOpen(true);
  }

  async function handleSamlSave() {
    if (!form.name.trim()) {
      setError(t("oauthProviderRequiredFields"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = { name: form.name.trim(), ...samlInputOf(samlForm, made) };
      if (editingSaml) {
        const updated = unwrap(await updateSamlProviderAction(editingSaml.id, input));
        setSamlProviders((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      } else {
        const created = unwrap(await createSamlProviderAction(input));
        setSamlProviders((prev) => [...prev, created]);
      }
      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("unexpectedError"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSamlToggle(provider: SamlProvider) {
    try {
      const updated = unwrap(
        await updateSamlProviderAction(provider.id, { enabled: !provider.enabled }),
      );
      setSamlProviders((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      console.error("Failed to toggle provider:", err);
    }
  }

  async function handleSamlDelete(id: string) {
    try {
      unwrap(await deleteSamlProviderAction(id));
      setSamlProviders((prev) => prev.filter((p) => p.id !== id));
      setDeleteSamlConfirm(null);
    } catch (err) {
      console.error("Failed to delete provider:", err);
    }
  }

  function openAddDialog() {
    setEditingProvider(null);
    setRotateClientSecret(true);
    setForm(emptyForm);
    setError(null);
    setDialogOpen(true);
  }

  function openEditDialog(provider: OAuthProviderView) {
    setEditingProvider(provider);
    setRotateClientSecret(false);
    setForm({
      name: provider.name,
      type: provider.type,
      clientId: provider.clientId,
      clientSecret: "",
      issuer: provider.issuer ?? "",
      authorizationUrl: provider.authorizationUrl ?? "",
      tokenUrl: provider.tokenUrl ?? "",
      userinfoUrl: provider.userinfoUrl ?? "",
      scopes: provider.scopes,
      autoLink: provider.autoLink,
      groupsClaim: provider.groupsClaim,
      groupPrefix: provider.groupPrefix ?? "",
      roleMappingEnabled: provider.roleMappingEnabled,
      adminGroup: provider.adminGroup ?? "",
      operatorGroup: provider.operatorGroup ?? "",
      userGroup: provider.userGroup ?? "",
      viewerGroup: provider.viewerGroup ?? "",
      defaultRole: provider.defaultRole,
      madeRoleGroups: madeRoleGroupsOf(provider.roleGroups),
      syncGroups: provider.syncGroups,
    });
    setError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    if (form.type === SAML_PROVIDER_TYPE) {
      await handleSamlSave();
      return;
    }
    const secretRequired =
      !editingProvider || rotateClientSecret || !editingProvider.hasClientSecret;
    if (
      !form.name.trim() ||
      !form.clientId.trim() ||
      (secretRequired && !form.clientSecret.trim())
    ) {
      setError(t("oauthProviderRequiredFields"));
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (editingProvider) {
        const update = withOAuthClientSecretRotation(
          {
            name: form.name.trim(),
            type: form.type,
            clientId: form.clientId.trim(),
            issuer: form.issuer.trim() || null,
            authorizationUrl: form.authorizationUrl.trim() || null,
            tokenUrl: form.tokenUrl.trim() || null,
            userinfoUrl: form.userinfoUrl.trim() || null,
            scopes: form.scopes.trim() || "openid email profile",
            autoLink: form.autoLink,
            groupsClaim: form.groupsClaim.trim() || "groups",
            groupPrefix: form.groupPrefix.trim() || null,
            roleMappingEnabled: form.roleMappingEnabled,
            adminGroup: form.adminGroup.trim() || null,
            operatorGroup: form.operatorGroup.trim() || null,
            userGroup: form.userGroup.trim() || null,
            viewerGroup: form.viewerGroup.trim() || null,
            roleGroups: roleGroupsInput(form, made),
            defaultRole: form.defaultRole,
            syncGroups: form.syncGroups,
          },
          secretRequired ? form.clientSecret : undefined,
        );
        const updated = unwrap(await updateOAuthProviderAction(editingProvider.id, update));
        if (updated) {
          setProviders((prev) => prev.map((p) => (p.id === editingProvider.id ? updated : p)));
        }
      } else {
        const created = unwrap(
          await createOAuthProviderAction({
            name: form.name.trim(),
            type: form.type,
            clientId: form.clientId.trim(),
            clientSecret: form.clientSecret.trim(),
            issuer: form.issuer.trim() || undefined,
            authorizationUrl: form.authorizationUrl.trim() || undefined,
            tokenUrl: form.tokenUrl.trim() || undefined,
            userinfoUrl: form.userinfoUrl.trim() || undefined,
            scopes: form.scopes.trim() || undefined,
            autoLink: form.autoLink,
            groupsClaim: form.groupsClaim.trim() || undefined,
            groupPrefix: form.groupPrefix.trim() || null,
            roleMappingEnabled: form.roleMappingEnabled,
            adminGroup: form.adminGroup.trim() || null,
            operatorGroup: form.operatorGroup.trim() || null,
            userGroup: form.userGroup.trim() || null,
            viewerGroup: form.viewerGroup.trim() || null,
            roleGroups: roleGroupsInput(form, made),
            defaultRole: form.defaultRole,
            syncGroups: form.syncGroups,
          }),
        );
        setProviders((prev) => [...prev, created]);
      }
      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("unexpectedError"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSetPrimary(provider: { id: string }) {
    // Clicking the current primary clears it - the only way back to alphabetical order.
    const next = primaryId === provider.id ? null : provider.id;
    setPrimaryId(next);
    try {
      unwrap(await setPrimaryOAuthProviderAction(next));
    } catch (err) {
      console.error("Failed to set the primary provider:", err);
      setPrimaryId(primaryId);
    }
  }

  async function handleToggleEnabled(provider: OAuthProviderView) {
    try {
      const updated = unwrap(
        await updateOAuthProviderAction(provider.id, { enabled: !provider.enabled }),
      );
      if (updated) {
        setProviders((prev) => prev.map((p) => (p.id === provider.id ? updated : p)));
      }
    } catch (err) {
      console.error("Failed to toggle provider:", err);
    }
  }

  async function handleDelete(id: string) {
    try {
      unwrap(await deleteOAuthProviderAction(id));
      setProviders((prev) => prev.filter((p) => p.id !== id));
      setDeleteConfirm(null);
    } catch (err) {
      console.error("Failed to delete provider:", err);
    }
  }

  function updateField<K extends keyof FormData>(field: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  const anyEnabled = providers.some((p) => p.enabled) || samlProviders.some((p) => p.enabled);
  const listed: ListedProvider[] = [
    ...providers.map((provider) => ({ kind: "oidc" as const, provider })),
    ...samlProviders.map((provider) => ({ kind: "saml" as const, provider })),
  ].sort((a, b) => a.provider.name.localeCompare(b.provider.name));

  return (
    <VStack gap={3}>
      {localUsersDisabled && (
        <Banner
          status={anyEnabled ? "info" : "error"}
          title={t("localUsersDisabledTitle")}
          description={
            anyEnabled ? t("localUsersDisabledWithProviders") : t("localUsersDisabledNoProvider")
          }
        />
      )}

      {listed.length === 0 && (
        <Banner
          status="info"
          title={t("noOauthProvidersConfigured")}
          description={t("providersEmptyDescription")}
        />
      )}

      {listed.map((entry) => {
        if (entry.kind === "saml") {
          const provider = entry.provider;
          const isPrimary = primaryId === provider.id;
          return (
            <Card key={provider.id} padding={3}>
              <VStack gap={2}>
                <HStack justify="between" gap={3} wrap="wrap" vAlign="center">
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text type="body" size="sm" weight="semibold">
                      {provider.name}
                    </Text>
                    <Badge label="SAML" />
                    {provider.roleMappingEnabled && <Badge label={t("groupRoles")} />}
                    {provider.syncGroups && <Badge label={t("groupSync")} />}
                    {!provider.enabled && <Badge variant="warning" label={t("disabled")} />}
                    {isPrimary && provider.enabled && (
                      <Badge
                        variant="neutral"
                        className="cpm-accent-badge"
                        label={t("primaryProvider")}
                      />
                    )}
                  </HStack>
                  <HStack gap={2} vAlign="center">
                    <Switch
                      label={t("enabled")}
                      value={provider.enabled}
                      onChange={() => handleSamlToggle(provider)}
                    />
                    <IconButton
                      variant="secondary"
                      size="sm"
                      label={isPrimary ? t("clearPrimary") : t("makePrimary")}
                      icon={
                        <Star
                          fill={isPrimary ? "currentColor" : "none"}
                          className={isPrimary ? "text-(--cpm-accent-text)" : undefined}
                        />
                      }
                      isDisabled={!provider.enabled}
                      tooltip={isPrimary ? t("clearPrimary") : t("makePrimary")}
                      onClick={() => handleSetPrimary(provider)}
                    />
                    <IconButton
                      variant="secondary"
                      size="sm"
                      label={tCommon("editNamed", { name: provider.name })}
                      icon={<Pencil />}
                      tooltip={t("editProvider")}
                      onClick={() => openSamlEditDialog(provider)}
                    />
                    <IconButton
                      variant="secondary"
                      size="sm"
                      label={tCommon("deleteNamed", { name: provider.name })}
                      icon={<Trash2 />}
                      tooltip={t("deleteProvider")}
                      onClick={() => setDeleteSamlConfirm(provider)}
                    />
                  </HStack>
                </HStack>
                <CodeBlock code={samlAcsUrl(baseUrl, provider.id)} width="100%" />
              </VStack>
            </Card>
          );
        }
        const provider = entry.provider;
        const isFromEnv = provider.source === "env";
        const isPrimary = primaryId === provider.id;
        return (
          <Card key={provider.id} padding={3}>
            <VStack gap={2}>
              <HStack justify="between" gap={3} wrap="wrap" vAlign="center">
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Text type="body" size="sm" weight="semibold">
                    {provider.name}
                  </Text>
                  <Badge label={provider.type.toUpperCase()} />
                  <Badge
                    variant={isFromEnv ? "info" : "neutral"}
                    label={isFromEnv ? t("providerSourceEnv") : t("providerSourceUi")}
                  />
                  {provider.roleMappingEnabled && <Badge label={t("groupRoles")} />}
                  {provider.syncGroups && <Badge label={t("groupSync")} />}
                  {!provider.enabled && <Badge variant="warning" label={t("disabled")} />}
                  {isPrimary && provider.enabled && (
                    <Badge
                      variant="neutral"
                      className="cpm-accent-badge"
                      label={t("primaryProvider")}
                    />
                  )}
                </HStack>
                <HStack gap={2} vAlign="center">
                  <Switch
                    label={t("enabled")}
                    value={provider.enabled}
                    onChange={() => handleToggleEnabled(provider)}
                  />
                  <IconButton
                    variant="secondary"
                    size="sm"
                    label={isPrimary ? t("clearPrimary") : t("makePrimary")}
                    // The badge's accent, so the button that sets the primary also shows it.
                    icon={
                      <Star
                        fill={isPrimary ? "currentColor" : "none"}
                        className={isPrimary ? "text-(--cpm-accent-text)" : undefined}
                      />
                    }
                    isDisabled={!provider.enabled}
                    tooltip={isPrimary ? t("clearPrimary") : t("makePrimary")}
                    onClick={() => handleSetPrimary(provider)}
                  />
                  <IconButton
                    variant="secondary"
                    size="sm"
                    label={tCommon("editNamed", { name: provider.name })}
                    icon={<Pencil />}
                    isDisabled={isFromEnv}
                    tooltip={isFromEnv ? t("envProviderCannotEdit") : t("editProvider")}
                    onClick={() => openEditDialog(provider)}
                  />
                  <IconButton
                    variant="secondary"
                    size="sm"
                    label={tCommon("deleteNamed", { name: provider.name })}
                    icon={<Trash2 />}
                    isDisabled={isFromEnv}
                    tooltip={isFromEnv ? t("envProviderCannotDelete") : t("deleteProvider")}
                    onClick={() => setDeleteConfirm(provider)}
                  />
                </HStack>
              </HStack>
              <CodeBlock code={callbackUrl(provider.id)} width="100%" />
            </VStack>
          </Card>
        );
      })}

      <HStack justify="end">
        <Button
          variant="primary"
          size="sm"
          icon={<Plus />}
          label={t("addProvider")}
          onClick={openAddDialog}
        />
      </HStack>

      <AlertDialog
        isOpen={deleteSamlConfirm !== null}
        onOpenChange={(open) => !open && setDeleteSamlConfirm(null)}
        title={t("deleteOauthProvider")}
        description={
          deleteSamlConfirm === null
            ? ""
            : t("deleteProviderConfirm", { name: deleteSamlConfirm.name })
        }
        actionLabel={t("deleteProvider")}
        onAction={() => deleteSamlConfirm && handleSamlDelete(deleteSamlConfirm.id)}
      />

      <AlertDialog
        isOpen={deleteConfirm !== null}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
        title={t("deleteOauthProvider")}
        description={
          deleteConfirm === null ? "" : t("deleteProviderConfirm", { name: deleteConfirm.name })
        }
        actionLabel={t("deleteProvider")}
        onAction={() => deleteConfirm && handleDelete(deleteConfirm.id)}
      />

      <AppDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={
          editingProvider || editingSaml ? t("editOauthProviderTitle") : t("addOauthProviderTitle")
        }
        maxWidth="lg"
        submitLabel={editingProvider || editingSaml ? tCommon("save") : tCommon("create")}
        onSubmit={handleSave}
        isSubmitting={saving}
      >
        <VStack gap={3}>
          <Text type="body" size="sm" color="secondary">
            {editingProvider || editingSaml
              ? t("oauthDialogEditDescription")
              : t("oauthDialogAddDescription")}
          </Text>

          {error && <Banner status="error" title={t("couldNotSaveProvider")} description={error} />}

          <TextInput
            label={tCommon("name")}
            isRequired
            size="sm"
            value={form.name}
            onChange={(v) => updateField("name", v)}
            placeholder={t("providerNamePlaceholder")}
          />

          <Selector
            label={t("type")}
            size="sm"
            // "OAuth2" is the protocol's name and reads the same in every language.
            options={[
              { value: "oidc", label: t("oauthTypeOidc") },
              { value: "oauth2", label: "OAuth2" },
              { value: SAML_PROVIDER_TYPE, label: "SAML 2.0" },
            ]}
            value={form.type}
            // A stored provider keeps its protocol; another one needs a provider of its own.
            isDisabled={editingProvider !== null || editingSaml !== null}
            onChange={(v) => updateField("type", v)}
          />

          {form.type === SAML_PROVIDER_TYPE ? (
            <SamlProviderFields
              value={samlForm}
              onChange={(patch) => setSamlForm((prev) => ({ ...prev, ...patch }))}
              editing={editingSaml}
              baseUrl={baseUrl}
            />
          ) : (
            <>
              <TextInput
                label={t("clientId")}
                isRequired
                size="sm"
                value={form.clientId}
                onChange={(v) => updateField("clientId", v)}
              />

              {editingProvider?.hasClientSecret && !rotateClientSecret ? (
                <HStack justify="between" vAlign="center" gap={3}>
                  <VStack gap={1}>
                    <Text type="label" size="sm">
                      {t("secretLabel")}
                    </Text>
                    <Text type="supporting">{t("storedSecretHelp")}</Text>
                  </VStack>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    label={t("rotate")}
                    onClick={() => setRotateClientSecret(true)}
                  />
                </HStack>
              ) : (
                <VStack gap={2}>
                  <TextInput
                    startIcon={KeyRound}
                    {...AUTOFILL_NEW_PASSWORD}
                    label={editingProvider ? t("newClientSecret") : t("secretLabel")}
                    isRequired
                    type="password"
                    size="sm"
                    value={form.clientSecret}
                    onChange={(v) => updateField("clientSecret", v)}
                  />
                  {editingProvider?.hasClientSecret && rotateClientSecret && (
                    // Otherwise a misclick on Rotate makes a new secret required, or costs the dialog.
                    <HStack justify="end">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        label={tCommon("keep")}
                        onClick={() => {
                          setRotateClientSecret(false);
                          updateField("clientSecret", "");
                        }}
                      />
                    </HStack>
                  )}
                </VStack>
              )}

              <TextInput
                startIcon={Link}
                label={t("issuerUrl")}
                isOptional
                size="sm"
                value={form.issuer}
                onChange={(v) => updateField("issuer", v)}
                placeholder="https://accounts.google.com"
                description={t("issuerUrlHelp")}
              />

              <TextInput
                startIcon={Link}
                label={t("authorizationUrl")}
                isOptional
                size="sm"
                value={form.authorizationUrl}
                onChange={(v) => updateField("authorizationUrl", v)}
                placeholder={t("overrideDiscoveredEndpoint")}
              />

              <TextInput
                startIcon={Link}
                label={t("tokenUrl")}
                isOptional
                size="sm"
                value={form.tokenUrl}
                onChange={(v) => updateField("tokenUrl", v)}
                placeholder={t("overrideDiscoveredEndpoint")}
              />

              <TextInput
                startIcon={Link}
                label={t("userinfoUrl")}
                isOptional
                size="sm"
                value={form.userinfoUrl}
                onChange={(v) => updateField("userinfoUrl", v)}
                placeholder={t("overrideDiscoveredEndpoint")}
              />

              <TextInput
                label={t("scopes")}
                size="sm"
                value={form.scopes}
                onChange={(v) => updateField("scopes", v)}
                placeholder={t("scopesPlaceholder")}
              />

              <Switch
                label={t("autoLinkAccounts")}
                value={form.autoLink}
                onChange={(v) => updateField("autoLink", v)}
                description={t("oauthAutoLinkHelp")}
              />

              <GroupMappingFields
                value={form}
                onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                claimLabel={t("groupsClaim")}
                claimHelp={t("groupsClaimHelp")}
              />

              {editingProvider && (
                <VStack gap={1}>
                  <Text type="label" size="sm" color="secondary">
                    {t("callbackUrl")}
                  </Text>
                  <CodeBlock code={callbackUrl(editingProvider.id)} width="100%" />
                </VStack>
              )}

              {/* Shown before saving too: it goes into the IdP's form beside the callback URL. */}
              <VStack gap={1}>
                <Text type="label" size="sm" color="secondary">
                  {t("backChannelLogoutUrl")}
                </Text>
                <CodeBlock code={backchannelLogoutUrl} width="100%" />
                <Text type="supporting">{t("backChannelLogoutHelp")}</Text>
              </VStack>
            </>
          )}
        </VStack>
      </AppDialog>
    </VStack>
  );
}
