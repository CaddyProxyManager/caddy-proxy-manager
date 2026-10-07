"use client";

import { useContext, useState } from "react";
import { Filter, KeyRound, Link, Pencil, Plug, Plus, Trash2, User } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import { AUTOFILL_NEW_PASSWORD, NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { isAppRole } from "@/src/lib/auth/oidc/groups";
import { parseBindNameTemplate } from "@/src/lib/ldap/bind-name";
import {
  ACTIVE_DIRECTORY_PRESET,
  DEFAULT_LDAP_CONFIG,
  DN_BIND_TEMPLATE_EXAMPLE,
  activeDirectoryBindTemplate,
  type LdapConfig,
  type LdapGroupSource,
} from "@/src/lib/ldap/defaults";
import type { LdapDirectoryInput, LdapDirectoryView } from "@/src/lib/models/ldap-directories";
import { unwrap } from "@/src/lib/errors/action-result";
import {
  type GroupMappingForm,
  GroupMappingFields,
  type MadeRole,
  MadeRolesContext,
  madeRoleGroupsOf,
  roleGroupsInput,
} from "./GroupMappingFields";
import {
  type LdapTestView,
  createLdapDirectoryAction,
  deleteLdapDirectoryAction,
  setLdapDirectoryEnabledAction,
  testLdapDirectoryAction,
  updateLdapDirectoryAction,
} from "./ldap-actions";

type Form = GroupMappingForm & {
  name: string;
  url: string;
  bindDn: string;
  bindPassword: string;
  autoLink: boolean;
  config: LdapConfig;
};

const emptyForm: Form = {
  name: "",
  url: "",
  bindDn: "",
  bindPassword: "",
  autoLink: false,
  config: DEFAULT_LDAP_CONFIG,
  groupsClaim: "",
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

function toForm(directory: LdapDirectoryView): Form {
  return {
    name: directory.name,
    url: directory.url,
    bindDn: directory.bindDn,
    bindPassword: "",
    autoLink: directory.autoLink,
    config: directory.config,
    groupsClaim: "",
    groupPrefix: directory.groupPrefix ?? "",
    roleMappingEnabled: directory.roleMappingEnabled,
    adminGroup: directory.adminGroup ?? "",
    operatorGroup: directory.operatorGroup ?? "",
    userGroup: directory.userGroup ?? "",
    viewerGroup: directory.viewerGroup ?? "",
    defaultRole: directory.defaultRole,
    madeRoleGroups: madeRoleGroupsOf(directory.roleGroups),
    syncGroups: directory.syncGroups,
  };
}

function toInput(form: Form, made: readonly MadeRole[]): LdapDirectoryInput {
  return {
    name: form.name,
    url: form.url,
    bindDn: form.bindDn,
    bindPassword: form.bindPassword,
    autoLink: form.autoLink,
    config: form.config,
    groupPrefix: form.groupPrefix,
    roleMappingEnabled: form.roleMappingEnabled,
    adminGroup: form.adminGroup,
    operatorGroup: form.operatorGroup,
    userGroup: form.userGroup,
    viewerGroup: form.viewerGroup,
    roleGroups: roleGroupsInput(form, made),
    defaultRole: form.defaultRole,
    syncGroups: form.syncGroups,
  };
}

export default function LdapDirectoriesSection({
  initialDirectories,
}: {
  initialDirectories: LdapDirectoryView[];
}) {
  const t = useTranslations("settings.ldap");
  const made = useContext(MadeRolesContext);
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  const tUsers = useTranslations("users");
  const format = useFormatter();
  const [directories, setDirectories] = useState(initialDirectories);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LdapDirectoryView | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<LdapDirectoryView | null>(null);
  const [probe, setProbe] = useState({ username: "", password: "" });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LdapTestView | null>(null);
  const [preset, setPreset] = useState<"openldap" | "ad" | null>(null);

  function openDialog(directory: LdapDirectoryView | null) {
    setEditing(directory);
    setForm(directory ? toForm(directory) : emptyForm);
    setError(null);
    setTestResult(null);
    setProbe({ username: "", password: "" });
    setPreset(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    // Drops typed passwords from client memory.
    setDialogOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setProbe({ username: "", password: "" });
    setTestResult(null);
  }

  function update<K extends keyof Form>(field: K, value: Form[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function updateConfig<K extends keyof LdapConfig>(field: K, value: LdapConfig[K]) {
    setForm((prev) => ({ ...prev, config: { ...prev.config, [field]: value } }));
  }

  function applyPreset(preset: "openldap" | "ad") {
    const values =
      preset === "ad"
        ? ACTIVE_DIRECTORY_PRESET
        : {
            userFilter: DEFAULT_LDAP_CONFIG.userFilter,
            nameAttribute: DEFAULT_LDAP_CONFIG.nameAttribute,
            groupSource: DEFAULT_LDAP_CONFIG.groupSource,
            groupFilter: DEFAULT_LDAP_CONFIG.groupFilter,
          };
    setPreset(preset);
    setForm((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        ...values,
        ...(prev.config.userDnTemplate !== null && {
          userDnTemplate:
            preset === "ad"
              ? activeDirectoryBindTemplate(prev.config.baseDn)
              : DN_BIND_TEMPLATE_EXAMPLE,
        }),
      },
    }));
  }

  /** AD binds by UPN; an existing AD directory is recognised by the preset's filter. */
  function bindTemplate(): string {
    const isAd =
      preset === "ad" || (preset === null && /samaccountname/i.test(form.config.userFilter));
    return isAd ? activeDirectoryBindTemplate(form.config.baseDn) : DN_BIND_TEMPLATE_EXAMPLE;
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const saved = unwrap(
        editing
          ? await updateLdapDirectoryAction(editing.id, toInput(form, made))
          : await createLdapDirectoryAction(toInput(form, made)),
      );
      setDirectories((prev) =>
        editing ? prev.map((d) => (d.id === saved.id ? saved : d)) : [...prev, saved],
      );
      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        unwrap(
          await testLdapDirectoryAction(
            toInput(form, made),
            editing?.id ?? null,
            probe.username.trim() ? probe : null,
          ),
        ),
      );
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : t("test.failed"),
        detail: null,
        identity: null,
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleToggle(directory: LdapDirectoryView) {
    try {
      const updated = unwrap(await setLdapDirectoryEnabledAction(directory.id, !directory.enabled));
      setDirectories((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    } catch (err) {
      console.error("Failed to toggle the directory:", err);
    }
  }

  async function handleDelete(directory: LdapDirectoryView) {
    try {
      unwrap(await deleteLdapDirectoryAction(directory.id));
      setDirectories((prev) => prev.filter((d) => d.id !== directory.id));
      setDeleteConfirm(null);
    } catch (err) {
      console.error("Failed to delete the directory:", err);
    }
  }

  const usesTemplate = form.config.userDnTemplate !== null;
  const templateKind = usesTemplate
    ? (parseBindNameTemplate(form.config.userDnTemplate ?? "")?.kind ?? null)
    : null;
  const passwordStored = !!editing?.hasBindPassword;
  const secure = form.url.trim().toLowerCase().startsWith("ldaps://");

  return (
    <VStack gap={3}>
      {directories.length === 0 && (
        <Banner status="info" title={t("emptyTitle")} description={t("emptyDescription")} />
      )}

      {directories.map((directory) => (
        <Card key={directory.id} padding={3}>
          <HStack justify="between" gap={3} wrap="wrap" vAlign="center">
            <VStack gap={1}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="body" size="sm" weight="semibold">
                  {directory.name}
                </Text>
                <Badge label="LDAP" />
                {directory.config.startTls && <Badge label="StartTLS" />}
                {!directory.config.tlsVerify && (
                  <Badge variant="warning" label={t("badgeTlsUnverified")} />
                )}
                {directory.roleMappingEnabled && <Badge label={tSettings("groupRoles")} />}
                {!directory.enabled && <Badge variant="warning" label={t("badgeDisabled")} />}
              </HStack>
              <Text type="body" size="sm" color="secondary">
                {directory.url}
              </Text>
            </VStack>
            <HStack gap={2} vAlign="center">
              <Switch
                label={t("enabled")}
                value={directory.enabled}
                onChange={() => handleToggle(directory)}
              />
              <IconButton
                variant="secondary"
                size="sm"
                label={tCommon("editNamed", { name: directory.name })}
                tooltip={t("edit")}
                icon={<Pencil />}
                onClick={() => openDialog(directory)}
              />
              <IconButton
                variant="secondary"
                size="sm"
                label={tCommon("deleteNamed", { name: directory.name })}
                tooltip={t("delete")}
                icon={<Trash2 />}
                onClick={() => setDeleteConfirm(directory)}
              />
            </HStack>
          </HStack>
        </Card>
      ))}

      <HStack justify="end">
        <Button
          variant="primary"
          size="sm"
          icon={<Plus />}
          label={t("add")}
          onClick={() => openDialog(null)}
        />
      </HStack>

      <AlertDialog
        isOpen={deleteConfirm !== null}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
        title={t("deleteTitle")}
        description={deleteConfirm ? t("deleteConfirm", { name: deleteConfirm.name }) : ""}
        actionLabel={t("delete")}
        onAction={() => deleteConfirm && handleDelete(deleteConfirm)}
      />

      <AppDialog
        open={dialogOpen}
        onClose={closeDialog}
        title={editing ? t("editTitle") : t("addTitle")}
        maxWidth="lg"
        submitLabel={editing ? tCommon("save") : t("add")}
        onSubmit={handleSave}
        isSubmitting={saving}
      >
        <VStack gap={3}>
          {error && <Banner status="error" title={t("saveFailed")} description={error} />}

          <TextInput
            label={tCommon("name")}
            isRequired
            size="sm"
            value={form.name}
            onChange={(v) => update("name", v)}
            placeholder={t("namePlaceholder")}
            description={t("nameHelp")}
          />

          <Toolbar
            label={t("presets")}
            size="sm"
            gap={2}
            startContent={
              <>
                <Text type="body" size="sm" color="secondary">
                  {t("presetLabel")}
                </Text>
                {/* Product names, the same in every language. */}
                <Button
                  type="button"
                  variant="secondary"
                  label="OpenLDAP"
                  onClick={() => applyPreset("openldap")}
                />
                <Button
                  type="button"
                  variant="secondary"
                  label="Active Directory"
                  onClick={() => applyPreset("ad")}
                />
              </>
            }
          />

          <TextInput
            startIcon={Link}
            {...NO_SPELLCHECK}
            label={t("url")}
            isRequired
            size="sm"
            value={form.url}
            onChange={(v) => update("url", v)}
            placeholder="ldaps://ldap.example.org"
            description={t("urlHelp")}
          />

          <Grid columns={{ minWidth: 200, max: 2 }} gap={2}>
            <Switch
              label={t("startTls")}
              value={form.config.startTls}
              isDisabled={secure}
              onChange={(v) => updateConfig("startTls", v)}
              description={t("startTlsHelp")}
            />
            <Switch
              label={t("tlsVerify")}
              value={form.config.tlsVerify}
              onChange={(v) => updateConfig("tlsVerify", v)}
              description={t("tlsVerifyHelp")}
            />
          </Grid>
          {!form.config.tlsVerify && (
            <Banner
              status="warning"
              title={t("tlsUnverifiedTitle")}
              description={t("tlsUnverifiedDescription")}
            />
          )}

          <TextArea
            {...NO_SPELLCHECK}
            label={t("caPem")}
            isOptional
            size="sm"
            rows={3}
            value={form.config.caPem ?? ""}
            onChange={(v) => updateConfig("caPem", v.trim() ? v : null)}
            placeholder="-----BEGIN CERTIFICATE-----"
            description={t("caPemHelp")}
          />

          <TextInput
            {...NO_SPELLCHECK}
            label={t("baseDn")}
            isRequired
            size="sm"
            value={form.config.baseDn}
            onChange={(v) => updateConfig("baseDn", v)}
            placeholder="dc=example,dc=org"
          />

          <RadioList
            label={t("mode")}
            value={usesTemplate ? "user" : "service"}
            onChange={(v) => updateConfig("userDnTemplate", v === "user" ? bindTemplate() : null)}
          >
            <RadioListItem
              value="service"
              label={t("modeServiceAccount")}
              description={t("modeServiceAccountHelp")}
            />
            <RadioListItem
              value="user"
              label={t("modeUserBind")}
              description={t("modeUserBindHelp")}
            />
          </RadioList>

          {usesTemplate ? (
            <>
              <TextInput
                {...NO_SPELLCHECK}
                label={t("dnTemplate")}
                isRequired
                size="sm"
                value={form.config.userDnTemplate ?? ""}
                onChange={(v) => updateConfig("userDnTemplate", v)}
                description={t("dnTemplateHelp")}
              />
              {templateKind !== "dn" && (
                <TextInput
                  startIcon={Filter}
                  {...NO_SPELLCHECK}
                  label={t("userFilter")}
                  isRequired
                  size="sm"
                  value={form.config.userFilter}
                  onChange={(v) => updateConfig("userFilter", v)}
                  description={t("userBindFilterHelp")}
                />
              )}
            </>
          ) : (
            <>
              <TextInput
                {...NO_SPELLCHECK}
                label={t("bindDn")}
                isOptional
                size="sm"
                value={form.bindDn}
                onChange={(v) => update("bindDn", v)}
                placeholder="cn=cpm,ou=services,dc=example,dc=org"
                description={t("bindDnHelp")}
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={t("bindPassword")}
                type="password"
                size="sm"
                value={form.bindPassword}
                onChange={(v) => update("bindPassword", v)}
                description={passwordStored ? t("bindPasswordStoredHelp") : t("bindPasswordHelp")}
              />
              <TextInput
                startIcon={Filter}
                {...NO_SPELLCHECK}
                label={t("userFilter")}
                isRequired
                size="sm"
                value={form.config.userFilter}
                onChange={(v) => updateConfig("userFilter", v)}
                description={t("userFilterHelp")}
              />
            </>
          )}

          <Grid columns={{ minWidth: 160, max: 2 }} gap={2}>
            <TextInput
              {...NO_SPELLCHECK}
              label={t("emailAttribute")}
              size="sm"
              value={form.config.emailAttribute}
              onChange={(v) => updateConfig("emailAttribute", v)}
            />
            <TextInput
              {...NO_SPELLCHECK}
              label={t("nameAttribute")}
              size="sm"
              value={form.config.nameAttribute}
              onChange={(v) => updateConfig("nameAttribute", v)}
            />
          </Grid>

          <Selector
            label={t("groupSource")}
            size="sm"
            options={[
              { value: "memberOf", label: t("groupSourceMemberOf") },
              { value: "search", label: t("groupSourceSearch") },
              { value: "none", label: t("groupSourceNone") },
            ]}
            value={form.config.groupSource}
            onChange={(v) => updateConfig("groupSource", v as LdapGroupSource)}
          />

          {form.config.groupSource === "search" && (
            <>
              <TextInput
                startIcon={Filter}
                {...NO_SPELLCHECK}
                label={t("groupFilter")}
                size="sm"
                value={form.config.groupFilter}
                onChange={(v) => updateConfig("groupFilter", v)}
                description={t("groupFilterHelp")}
              />
              <Grid columns={{ minWidth: 160, max: 2 }} gap={2}>
                <TextInput
                  {...NO_SPELLCHECK}
                  label={t("groupBaseDn")}
                  isOptional
                  size="sm"
                  value={form.config.groupBaseDn ?? ""}
                  onChange={(v) => updateConfig("groupBaseDn", v.trim() ? v : null)}
                />
                <TextInput
                  {...NO_SPELLCHECK}
                  label={t("groupNameAttribute")}
                  size="sm"
                  value={form.config.groupNameAttribute}
                  onChange={(v) => updateConfig("groupNameAttribute", v)}
                />
              </Grid>
            </>
          )}

          <Switch
            label={t("autoLink")}
            value={form.autoLink}
            onChange={(v) => update("autoLink", v)}
            description={t("autoLinkHelp")}
          />

          <GroupMappingFields
            value={form}
            onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
            description={t("groupMappingHelp")}
          />

          <Card variant="muted" padding={3}>
            <VStack gap={3}>
              <VStack gap={0}>
                <Text type="body" size="sm" weight="semibold">
                  {t("test.title")}
                </Text>
                <Text type="supporting">{t("test.help")}</Text>
              </VStack>
              <Grid columns={{ minWidth: 160, max: 2 }} gap={2}>
                <TextInput
                  startIcon={User}
                  {...NO_SPELLCHECK}
                  label={t("test.username")}
                  isOptional
                  size="sm"
                  value={probe.username}
                  onChange={(v) => setProbe((prev) => ({ ...prev, username: v }))}
                />
                <TextInput
                  startIcon={KeyRound}
                  {...AUTOFILL_NEW_PASSWORD}
                  label={t("test.password")}
                  isOptional
                  type="password"
                  size="sm"
                  value={probe.password}
                  onChange={(v) => setProbe((prev) => ({ ...prev, password: v }))}
                />
              </Grid>
              <HStack>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<Plug />}
                  label={testing ? tCommon("testing") : tCommon("test")}
                  isLoading={testing}
                  onClick={handleTest}
                />
              </HStack>
              {testResult && (
                <Banner
                  status={testResult.ok ? "success" : "error"}
                  title={testResult.message}
                  description={testResult.detail ?? undefined}
                />
              )}
              {testResult?.identity && (
                <MetadataList>
                  <MetadataListItem label={t("test.dn")}>{testResult.identity.dn}</MetadataListItem>
                  <MetadataListItem label={tCommon("email")}>
                    {testResult.identity.email ?? t("test.none")}
                  </MetadataListItem>
                  <MetadataListItem label={tNav("groups")}>
                    {testResult.identity.groups.length > 0
                      ? format.list(testResult.identity.groups, { type: "unit" })
                      : t("test.none")}
                  </MetadataListItem>
                  {testResult.identity.role && (
                    <MetadataListItem label={tCommon("role")}>
                      {isAppRole(testResult.identity.role)
                        ? tUsers(`roles.${testResult.identity.role}`)
                        : (made.find((role) => role.key === testResult.identity?.role)?.name ??
                          testResult.identity.role)}
                    </MetadataListItem>
                  )}
                </MetadataList>
              )}
            </VStack>
          </Card>
        </VStack>
      </AppDialog>
    </VStack>
  );
}
