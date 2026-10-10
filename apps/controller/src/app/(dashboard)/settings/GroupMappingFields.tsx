"use client";

import { createContext, useContext } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";

/** The roles an administrator made, which a provider can map groups to beside the built-in ones. */
export type MadeRole = { key: string; name: string };

export const MadeRolesContext = createContext<readonly MadeRole[]>([]);

export type GroupMappingForm = {
  groupsClaim: string;
  /** OIDC only; empty reads roles from the groups claim. */
  rolesClaim?: string;
  groupPrefix: string;
  roleMappingEnabled: boolean;
  adminGroup: string;
  operatorGroup: string;
  userGroup: string;
  viewerGroup: string;
  defaultRole: string;
  /** A made role's key to its comma-separated group names. */
  madeRoleGroups: Record<string, string>;
  syncGroups: boolean;
};

/** A provider's made roles as the form edits them. */
export function madeRoleGroupsOf(roleGroups: Record<string, string[]> | undefined) {
  return Object.fromEntries(
    Object.entries(roleGroups ?? {})
      .filter(([role]) => !(ROLE_OPTIONS as readonly string[]).includes(role))
      .map(([role, names]) => [role, names.join(", ")]),
  );
}

/** What a save sends for the made roles: every one the form shows, so a cleared field clears. */
export function roleGroupsInput(form: GroupMappingForm, made: readonly MadeRole[]) {
  return Object.fromEntries(
    made.map((role) => [
      role.key,
      (form.madeRoleGroups[role.key] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ]),
  );
}

const ROLE_OPTIONS = ["admin", "operator", "user", "viewer"] as const;

/** Shared by OIDC providers and LDAP directories; a directory has no claim to name. */
export function GroupMappingFields({
  value,
  onChange,
  claimLabel,
  claimHelp,
  rolesClaimLabel,
  rolesClaimHelp,
  description,
}: {
  value: GroupMappingForm;
  onChange: (patch: Partial<GroupMappingForm>) => void;
  /** Omitted, the groups-claim field is not shown. */
  claimLabel?: string;
  claimHelp?: string;
  /** Omitted, the roles-claim field is not shown. */
  rolesClaimLabel?: string;
  rolesClaimHelp?: string;
  description?: string;
}) {
  const t = useTranslations("settings");
  const tUsers = useTranslations("users");
  const made = useContext(MadeRolesContext);
  return (
    <Card variant="muted" padding={3}>
      <VStack gap={3}>
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold">
            {t("groupMapping")}
          </Text>
          <Text type="supporting">{description ?? t("groupMappingHelp")}</Text>
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
            {rolesClaimLabel && (
              <TextInput
                label={rolesClaimLabel}
                isOptional
                size="sm"
                value={value.rolesClaim ?? ""}
                onChange={(v) => onChange({ rolesClaim: v })}
                placeholder={value.groupsClaim || "groups"}
                description={rolesClaimHelp}
              />
            )}
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
              {made.map((role) => (
                <TextInput
                  key={role.key}
                  label={t("madeRoleGroups", { role: role.name })}
                  size="sm"
                  value={value.madeRoleGroups[role.key] ?? ""}
                  onChange={(v) =>
                    onChange({ madeRoleGroups: { ...value.madeRoleGroups, [role.key]: v } })
                  }
                />
              ))}
            </Grid>
            <Text type="supporting">{t("roleGroupNamesHelp")}</Text>

            <Selector
              label={t("defaultRoleLabel")}
              size="sm"
              options={[
                ...ROLE_OPTIONS.map((role) => ({
                  value: role as string,
                  label: tUsers(`roles.${role}`),
                })),
                ...made.map((role) => ({ value: role.key, label: role.name })),
              ]}
              value={value.defaultRole}
              onChange={(v) => onChange({ defaultRole: v })}
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
