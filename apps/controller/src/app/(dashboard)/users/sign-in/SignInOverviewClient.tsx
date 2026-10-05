"use client";

/**
 * Every way into this instance on one page, read-only: each switch it reports links to where it
 * is changed. The preview is drawn from the same facts the login page is, not a screenshot of it.
 */
import { ArrowLeft, KeyRound, LogIn, User } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useTranslations } from "next-intl";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { SignInProviders } from "@/src/components/auth/SignInProviders";
import type { RoleMapping, SignInOverview } from "@/src/lib/users/sign-in-overview";

type MethodRow = {
  id: string;
  name: string;
  kind: "password" | "passkey" | "oidc" | "ldap";
  status: "on" | "off" | "unreachable";
  accounts: number;
  notes: string[];
  href: string;
};

type MappingRow = { id: string; source: string; external: string; becomes: string };

const STATUS_DOT = {
  on: "success",
  off: "neutral",
  unreachable: "error",
} as const;

export function SignInOverviewClient({
  overview,
  appName,
}: {
  overview: SignInOverview;
  appName: string;
}) {
  const t = useTranslations("signInOverview");

  const methods: MethodRow[] = [
    {
      id: "password",
      name: t("methods.password"),
      kind: "password",
      status: overview.password.enabled ? "on" : "off",
      accounts: overview.password.accounts,
      notes: overview.password.selfRegistration ? [t("notes.selfRegistration")] : [],
      href: "/settings/authentication#sign-in",
    },
    {
      id: "passkey",
      name: t("methods.passkey"),
      kind: "passkey",
      status: overview.passkeys.enabled ? "on" : "off",
      accounts: overview.passkeys.accounts,
      notes: [
        overview.passkeys.rpId
          ? t("notes.passkeyHost", { host: overview.passkeys.rpId })
          : t("notes.passkeyNoHost"),
        t("notes.passkeysRegistered", { count: overview.passkeys.registered }),
      ],
      href: "/settings/general#instance",
    },
    ...overview.providers.map(
      (provider): MethodRow => ({
        id: `oidc:${provider.id}`,
        name: provider.name,
        kind: "oidc",
        status: provider.enabled ? "on" : "off",
        accounts: provider.linked,
        notes: [
          ...(provider.primary ? [t("notes.primary")] : []),
          ...(provider.autoLink ? [t("notes.autoLink")] : []),
          ...(provider.syncGroups ? [t("notes.syncGroups")] : []),
        ],
        href: "/settings/authentication#oauth",
      }),
    ),
    ...overview.directories.map(
      (directory): MethodRow => ({
        id: `ldap:${directory.id}`,
        name: directory.name,
        kind: "ldap",
        status: !directory.enabled
          ? "off"
          : directory.health === "unreachable"
            ? "unreachable"
            : "on",
        accounts: directory.linked,
        notes: [
          directory.health === "unreachable"
            ? t("notes.unreachable", { stage: directory.failure ?? "" })
            : directory.health === "ok"
              ? t("notes.reachable")
              : t("notes.unchecked"),
          ...(directory.syncGroups ? [t("notes.syncGroups")] : []),
        ],
        href: "/settings/authentication#ldap",
      }),
    ),
  ];

  const mappingRows: MappingRow[] = [
    ...[...overview.providers, ...overview.directories].flatMap((source) =>
      roleRows(source.id, source.name, source.roles, t),
    ),
    ...overview.groupMappings.map((mapping, index) => ({
      id: `group:${index}`,
      source: mapping.provider ?? t("anyProvider"),
      external: mapping.externalName,
      becomes: t("becomesGroup", { group: mapping.group }),
    })),
  ];
  const mappingColumns: Column<MappingRow>[] = [
    { id: "source", label: t("columns.source"), render: (row) => row.source },
    {
      id: "external",
      label: t("columns.externalGroup"),
      render: (row) => (
        <Text type="code" size="sm">
          {row.external}
        </Text>
      ),
    },
    { id: "becomes", label: t("columns.becomes"), render: (row) => row.becomes },
  ];

  const enabledProviders = overview.providers.filter((provider) => provider.enabled);
  const enabledDirectories = overview.directories.filter((directory) => directory.enabled);

  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft />}
            label={t("backToUsers")}
            href="/users"
          />
        </HStack>
        <Heading level={1}>{t("title")}</Heading>
        <Text type="body" color="secondary">
          {t("description")}
        </Text>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>{t("methodsTitle")}</Heading>
        <Card padding={0}>
          <List hasDividers>
            {methods.map((row) => (
              <ListItem
                key={row.id}
                startContent={
                  <StatusDot variant={STATUS_DOT[row.status]} label={t(`status.${row.status}`)} />
                }
                label={row.name}
                description={
                  <HStack gap={2} wrap="wrap" vAlign="center">
                    <Text type="body" size="xsm" color="secondary">
                      {t(`kinds.${row.kind}`)} · {t(`status.${row.status}`)} ·{" "}
                      {t("accountCount", { count: row.accounts })}
                    </Text>
                    {row.notes.map((note) => (
                      <Token key={note} size="sm" label={note} />
                    ))}
                  </HStack>
                }
                endContent={
                  <Button
                    variant="ghost"
                    size="sm"
                    label={t("configure")}
                    aria-label={t("configureNamed", { name: row.name })}
                    href={row.href}
                  />
                }
              />
            ))}
          </List>
        </Card>
        <Text type="supporting" color="secondary">
          {overview.externalRegistration
            ? t("externalRegistrationOn")
            : t("externalRegistrationOff")}
        </Text>
      </VStack>

      <Grid columns={{ minWidth: 320, max: 2 }} gap={4}>
        <Card padding={4}>
          <VStack gap={3}>
            <Heading level={2}>{t("mfaTitle")}</Heading>
            <HStack gap={2} vAlign="center">
              <StatusDot
                variant={overview.mfa.mode === "off" ? "neutral" : "success"}
                label={t(`mfaModes.${overview.mfa.mode}`)}
              />
              <Text type="body" size="sm" weight="medium">
                {t(`mfaModes.${overview.mfa.mode}`)}
              </Text>
            </HStack>
            {overview.mfa.mode !== "off" && (
              <Text type="body" size="sm" color="secondary">
                {t("mfaGrace", { days: overview.mfa.graceDays })}
              </Text>
            )}
            <Text type="body" size="sm" color="secondary">
              {t("mfaCounts", {
                totp: overview.mfa.withTotp,
                passkey: overview.mfa.withPasskey,
              })}
            </Text>
            <HStack>
              <Button
                variant="secondary"
                size="sm"
                label={t("mfaConfigure")}
                href="/settings/authentication#two-factor"
              />
            </HStack>
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <Heading level={2}>{t("previewTitle")}</Heading>
            <Text type="body" size="sm" color="secondary">
              {t("previewDescription")}
            </Text>
            <LoginPreview
              appName={appName}
              passwordForm={overview.password.enabled || enabledDirectories.length > 0}
              directories={enabledDirectories.map((directory) => directory.name)}
              passkey={overview.passkeys.enabled}
              providers={enabledProviders.map((provider) => ({
                id: provider.id,
                name: provider.name,
                isPrimary: provider.primary,
              }))}
            />
          </VStack>
        </Card>
      </Grid>

      <VStack gap={2}>
        <Heading level={2}>{t("mappingsTitle")}</Heading>
        <DataTable
          columns={mappingColumns}
          data={mappingRows}
          keyField="id"
          emptyMessage={t("mappingsEmpty")}
        />
      </VStack>
    </VStack>
  );
}

type Translate = ReturnType<typeof useTranslations<"signInOverview">>;

/** One row per role a source maps a group to, then its default for everyone else. */
function roleRows(id: string, name: string, mapping: RoleMapping, t: Translate): MappingRow[] {
  if (!mapping.enabled) return [];
  const pairs = (["admin", "operator", "user", "viewer"] as const).flatMap((role) =>
    mapping[role] ? [[role, mapping[role]] as const] : [],
  );
  return [
    ...pairs.map(([role, group]) => ({
      id: `${id}:${role}`,
      source: name,
      external: group ?? "",
      becomes: t("becomesRole", { role: t(`roles.${role}`) }),
    })),
    {
      id: `${id}:default`,
      source: name,
      external: t("anyOtherGroup"),
      becomes: t("becomesRole", {
        role: t(`roles.${mapping.defaultRole as "admin" | "operator" | "user" | "viewer"}`),
      }),
    },
  ];
}

/** The login card's first step as the facts make it, inert: nothing here signs anyone in. */
function LoginPreview({
  appName,
  passwordForm,
  directories,
  passkey,
  providers,
}: {
  appName: string;
  passwordForm: boolean;
  directories: string[];
  passkey: boolean;
  providers: { id: string; name: string; isPrimary: boolean }[];
}) {
  const t = useTranslations("signInOverview");
  const tLogin = useTranslations("auth.login");
  const tPasskey = useTranslations("auth.passkey");
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Heading level={3}>{appName}</Heading>
        {passwordForm && (
          <VStack gap={2}>
            <TextInput
              label={tLogin("username")}
              startIcon={User}
              value=""
              onChange={() => {}}
              isDisabled
            />
            {directories.length > 1 && (
              <Text type="supporting" color="secondary">
                {t("previewDirectories", { names: directories.join(", ") })}
              </Text>
            )}
            <Button variant="primary" label={tLogin("continueStep")} width="100%" isDisabled />
          </VStack>
        )}
        {passkey && (
          <Button
            variant="secondary"
            icon={<KeyRound />}
            label={tPasskey("signIn")}
            width="100%"
            isDisabled
          />
        )}
        {providers.length > 0 && (passwordForm || passkey) && <Divider />}
        {providers.length > 0 && (
          <SignInProviders providers={providers} pendingId={null} isDisabled onSelect={() => {}} />
        )}
        {!passwordForm && !passkey && providers.length === 0 && (
          <HStack gap={2} vAlign="center">
            <LogIn size={16} aria-hidden="true" />
            <Text type="body" size="sm" color="secondary">
              {t("previewNothing")}
            </Text>
          </HStack>
        )}
      </VStack>
    </Card>
  );
}
