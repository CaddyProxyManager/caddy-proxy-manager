"use client";

import { Link } from "lucide-react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import type { SamlProvider } from "@/src/lib/models/saml-providers";
import { samlAcsUrl, samlSpMetadataUrl } from "@/src/lib/auth/saml/urls";
import {
  type GroupMappingForm,
  GroupMappingFields,
  type MadeRole,
  madeRoleGroupsOf,
  roleGroupsInput,
} from "./GroupMappingFields";

export type SamlForm = GroupMappingForm & {
  metadataUrl: string;
  metadataXml: string;
  spEntityId: string;
  emailAttribute: string;
  nameAttribute: string;
  linkDomains: string;
};

export const emptySamlForm: SamlForm = {
  metadataUrl: "",
  metadataXml: "",
  spEntityId: "",
  emailAttribute: "email",
  nameAttribute: "displayName",
  linkDomains: "",
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

export function samlFormOf(provider: SamlProvider): SamlForm {
  return {
    metadataUrl: provider.metadataUrl ?? "",
    // With a URL the stored copy is refetched on save; showing it would invite editing a copy.
    metadataXml: provider.metadataUrl ? "" : provider.metadataXml,
    spEntityId: provider.spEntityId,
    emailAttribute: provider.emailAttribute,
    nameAttribute: provider.nameAttribute,
    linkDomains: provider.linkDomains,
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
  };
}

/** What a save sends; the model fills in what is blank. */
export function samlInputOf(form: SamlForm, made: readonly MadeRole[]) {
  return {
    metadataUrl: form.metadataUrl.trim() || null,
    metadataXml: form.metadataXml.trim() || null,
    spEntityId: form.spEntityId.trim() || undefined,
    emailAttribute: form.emailAttribute.trim(),
    nameAttribute: form.nameAttribute.trim(),
    linkDomains: form.linkDomains.trim(),
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
  };
}

export function SamlProviderFields({
  value,
  onChange,
  editing,
  baseUrl,
}: {
  value: SamlForm;
  onChange: (patch: Partial<SamlForm>) => void;
  editing: SamlProvider | null;
  baseUrl: string;
}) {
  const t = useTranslations("settings.saml");
  return (
    <VStack gap={3}>
      <TextInput
        startIcon={Link}
        label={t("metadataUrl")}
        isOptional
        size="sm"
        value={value.metadataUrl}
        onChange={(metadataUrl) => onChange({ metadataUrl })}
        description={t("metadataUrlHelp")}
      />
      {!value.metadataUrl.trim() && (
        <TextArea
          label={t("metadataXml")}
          isOptional
          size="sm"
          rows={6}
          value={value.metadataXml}
          onChange={(metadataXml) => onChange({ metadataXml })}
          description={t("metadataXmlHelp")}
        />
      )}
      <TextInput
        label={t("spEntityId")}
        isOptional
        size="sm"
        value={value.spEntityId}
        onChange={(spEntityId) => onChange({ spEntityId })}
        description={t("spEntityIdHelp")}
      />
      <TextInput
        label={t("emailAttribute")}
        size="sm"
        value={value.emailAttribute}
        onChange={(emailAttribute) => onChange({ emailAttribute })}
      />
      <TextInput
        label={t("nameAttribute")}
        size="sm"
        value={value.nameAttribute}
        onChange={(nameAttribute) => onChange({ nameAttribute })}
      />
      <TextInput
        label={t("linkDomains")}
        isOptional
        size="sm"
        value={value.linkDomains}
        onChange={(linkDomains) => onChange({ linkDomains })}
        placeholder="example.com"
        description={t("linkDomainsHelp")}
      />
      <GroupMappingFields
        value={value}
        onChange={(patch) => onChange(patch)}
        claimLabel={t("groupsAttribute")}
        claimHelp={t("groupsAttributeHelp")}
      />
      {editing ? (
        <VStack gap={2}>
          {editing.idpEntityId && (
            <Text type="supporting">
              {t("idpSummary", {
                entityId: editing.idpEntityId,
                certificates: editing.certificateCount,
              })}
            </Text>
          )}
          <VStack gap={1}>
            <Text type="label" size="sm" color="secondary">
              {t("acsUrl")}
            </Text>
            <CodeBlock code={samlAcsUrl(baseUrl, editing.id)} width="100%" />
          </VStack>
          <VStack gap={1}>
            <Text type="label" size="sm" color="secondary">
              {t("spMetadataUrl")}
            </Text>
            <CodeBlock code={samlSpMetadataUrl(baseUrl, editing.id)} width="100%" />
          </VStack>
        </VStack>
      ) : (
        <Text type="supporting">{t("urlsAfterSave")}</Text>
      )}
    </VStack>
  );
}
