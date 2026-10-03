"use client";

import { useTranslations } from "next-intl";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";

export type AppRole = "admin" | "operator" | "user" | "viewer";

export type GroupMappingForm = {
  groupsClaim: string;
  groupPrefix: string;
  roleMappingEnabled: boolean;
  adminGroup: string;
  operatorGroup: string;
  userGroup: string;
  viewerGroup: string;
  defaultRole: AppRole;
  syncGroups: boolean;
};

const ROLE_OPTIONS = [
  { value: "admin", labelKey: "roleAdmin" },
  { value: "operator", labelKey: "roleOperator" },
  { value: "user", labelKey: "roleUser" },
  { value: "viewer", labelKey: "roleViewer" },
] as const;

/** Shared by OIDC providers and LDAP directories; a directory has no claim to name. */
export function GroupMappingFields({
  value,
  onChange,
  claimLabel,
  claimHelp,
  description,
}: {
  value: GroupMappingForm;
  onChange: (patch: Partial<GroupMappingForm>) => void;
  /** Omitted, the groups-claim field is not shown. */
  claimLabel?: string;
  claimHelp?: string;
  description?: string;
}) {
  const t = useTranslations("settings");
  return (
    <Card variant="muted" padding={3}>
      <VStack gap={3}>
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold">
            {t("groupMapping")}
          </Text>
          <Text type="body" size="xsm" color="secondary">
            {description ?? t("groupMappingHelp")}
          </Text>
        </VStack>

        {/* No <code> in the help: Astryx types a description as a string, and only
            that keeps its aria-describedby link. */}
        {claimLabel && (
          <TextInput
            label={claimLabel}
            size="sm"
            value={value.groupsClaim}
            onChange={(v) => onChange({ groupsClaim: v })}
            placeholder="groups"
            description={claimHelp}
          />
        )}

        <TextInput
          label={t("groupPrefix")}
          isOptional
          size="sm"
          value={value.groupPrefix}
          onChange={(v) => onChange({ groupPrefix: v })}
          placeholder="CPM_"
          description={t("groupPrefixHelp")}
        />

        <Switch
          label={t("assignRolesFromGroups")}
          value={value.roleMappingEnabled}
          onChange={(v) => onChange({ roleMappingEnabled: v })}
          description={t("roleMappingAuthorityHelp")}
        />

        {value.roleMappingEnabled && (
          <>
            <Grid columns={{ minWidth: 160, max: 3 }} gap={2}>
              <TextInput
                label={t("adminGroups")}
                size="sm"
                value={value.adminGroup}
                onChange={(v) => onChange({ adminGroup: v })}
                placeholder={value.groupPrefix ? `${value.groupPrefix}Admin` : "platform-owners"}
              />
              <TextInput
                label={t("operatorGroups")}
                size="sm"
                value={value.operatorGroup}
                onChange={(v) => onChange({ operatorGroup: v })}
                placeholder={value.groupPrefix ? `${value.groupPrefix}Operator` : "proxy-ops"}
              />
              <TextInput
                label={t("userGroups")}
                size="sm"
                value={value.userGroup}
                onChange={(v) => onChange({ userGroup: v })}
                placeholder={value.groupPrefix ? `${value.groupPrefix}User` : "staff"}
              />
              <TextInput
                label={t("viewerGroups")}
                size="sm"
                value={value.viewerGroup}
                onChange={(v) => onChange({ viewerGroup: v })}
                placeholder={value.groupPrefix ? `${value.groupPrefix}Viewer` : "auditors"}
              />
            </Grid>
            <Text type="body" size="xsm" color="secondary">
              {t("roleGroupNamesHelp")}
            </Text>

            <Selector
              label={t("defaultRoleLabel")}
              size="sm"
              options={ROLE_OPTIONS.map(({ value: role, labelKey }) => ({
                value: role,
                label: t(labelKey),
              }))}
              value={value.defaultRole}
              onChange={(v) => onChange({ defaultRole: v as AppRole })}
            />
          </>
        )}

        <Switch
          label={t("mirrorGroupsIntoCpm")}
          value={value.syncGroups}
          onChange={(v) => onChange({ syncGroups: v })}
          description={t("groupSyncHelp")}
        />
      </VStack>
    </Card>
  );
}
