"use client";

/**
 * SCIM connections: one per identity provider that provisions accounts and groups here. A token
 * is shown once, when a connection is made or its token rotated. Under SQLite the page says SCIM
 * needs PostgreSQL and nothing else.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ArrowLeft, MoreHorizontal, Plus } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { AppDialog } from "@/components/ui/AppDialog";
import { Timestamp } from "@/components/ui/Timestamp";
import { useTableDensity } from "@/components/ui/TableDensity";
import type { ScimConnection } from "@/src/lib/scim/connections";
import {
  deleteScimConnectionAction,
  rotateScimTokenAction,
  saveScimConnectionAction,
} from "./actions";
import { unwrap } from "@/src/lib/errors/action-result";

export type MappableRole = { key: string; name: string | null; builtIn: boolean };

const BUILT_IN = ["operator", "user", "viewer"] as const;
type BuiltIn = (typeof BUILT_IN)[number];

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function useRoleName() {
  const tUsers = useTranslations("users");
  return (role: MappableRole) =>
    role.builtIn && (BUILT_IN as readonly string[]).includes(role.key)
      ? tUsers(`roles.${role.key as BuiltIn}`)
      : (role.name ?? role.key);
}

export default function ScimConnectionsClient({
  supported,
  endpoint,
  connections,
  roles,
  canWrite,
}: {
  supported: boolean;
  endpoint: string;
  connections: ScimConnection[];
  roles: MappableRole[];
  canWrite: boolean;
}) {
  const t = useTranslations("scim");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const tSettings = useTranslations("settings");
  const router = useRouter();
  const density = useTableDensity();
  const [editing, setEditing] = useState<ScimConnection | null>(null);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<ScimConnection | null>(null);
  const [deleting, setDeleting] = useState<ScimConnection | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rotate(connection: ScimConnection) {
    setError(null);
    try {
      setToken(unwrap(await rotateScimTokenAction(connection.id)));
    } catch (err) {
      setError(message(err, t("actionFailed")));
    } finally {
      router.refresh();
    }
  }

  async function remove(connection: ScimConnection) {
    setError(null);
    try {
      unwrap(await deleteScimConnectionAction(connection.id));
    } catch (err) {
      setError(message(err, t("actionFailed")));
    } finally {
      router.refresh();
    }
  }

  type Row = ScimConnection & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <HStack gap={1} vAlign="center">
            <Text type="body" size="sm" weight="semibold" maxLines={1}>
              {row.name}
            </Text>
            {!row.enabled && <Token size="sm" color="gray" label={t("turnedOff")} />}
          </HStack>
          <Text type="supporting" color="secondary">
            {t("tokenEnding", { hint: row.tokenHint })}
          </Text>
        </VStack>
      ),
    },
    {
      key: "provisioned",
      header: t("provisioned"),
      width: pixel(200),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          {t("provisionedCounts", { users: row.users, groups: row.groups })}
        </Text>
      ),
    },
    {
      key: "lastUsed",
      header: t("lastUsed"),
      width: pixel(180),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          {row.lastUsedAt ? <Timestamp value={row.lastUsedAt} /> : tCommon("never")}
        </Text>
      ),
    },
    {
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(56),
      align: "end",
      renderCell: (row) => (
        <DropdownMenu
          hasChevron={false}
          alignment="end"
          button={{
            variant: "ghost",
            icon: <MoreHorizontal />,
            label: tCommon("actionsFor", { name: row.name }),
            isIconOnly: true,
          }}
          items={[
            {
              id: "view",
              label: canWrite ? tCommon("edit") : tCommon("view"),
              onClick: () => setEditing(row),
            },
            ...(canWrite
              ? [
                  { id: "rotate", label: tSettings("rotate"), onClick: () => setRotating(row) },
                  { type: "divider" as const },
                  {
                    id: "delete",
                    label: tCommon("delete"),
                    variant: "destructive" as const,
                    onClick: () => setDeleting(row),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];

  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft />}
            label={tNav("users")}
            href="/users"
          />
        </HStack>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={1}>{t("title")}</Heading>
          {supported && canWrite && (
            <Button
              size="sm"
              icon={<Plus />}
              label={tCommon("new")}
              onClick={() => setCreating(true)}
            />
          )}
        </HStack>
        <Text type="body" color="secondary">
          {t("description")}
        </Text>
      </VStack>

      {!supported ? (
        <Banner status="warning" title={t("postgresOnlyTitle")} description={t("postgresOnly")} />
      ) : (
        <>
          {error && <Banner status="error" title={t("actionFailed")} description={error} />}
          {token && (
            <Card padding={3}>
              <VStack gap={2}>
                <Text type="body" size="sm" weight="semibold">
                  {t("tokenOnce")}
                </Text>
                <CodeBlock code={token} width="100%" />
                <HStack>
                  <Button
                    variant="secondary"
                    size="sm"
                    label={tCommon("done")}
                    onClick={() => setToken(null)}
                  />
                </HStack>
              </VStack>
            </Card>
          )}
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("endpoint")}
            </Text>
            <CodeBlock code={endpoint} width="100%" />
            <Text type="supporting" color="secondary">
              {t("endpointHelp")}
            </Text>
          </VStack>
          {connections.length === 0 ? (
            <EmptyState
              headingLevel={2}
              title={t("emptyTitle")}
              description={t("emptyDescription")}
            />
          ) : (
            <Card padding={0}>
              <Table
                density={density}
                data={connections.map((connection) => ({ ...connection }))}
                columns={columns}
                idKey="id"
                hasHover
              />
            </Card>
          )}
        </>
      )}

      {/* Mounted only while open: a closed form would still answer its labels to tests and AT. */}
      {(creating || editing) && (
        <ConnectionDialog
          connection={editing}
          roles={roles}
          isReadOnly={!canWrite}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(newToken) => {
            if (newToken) setToken(newToken);
            router.refresh();
          }}
        />
      )}
      <AlertDialog
        isOpen={rotating !== null}
        onOpenChange={(isOpen) => !isOpen && setRotating(null)}
        title={t("rotateTitle")}
        description={rotating ? t("rotateConfirm", { name: rotating.name }) : ""}
        actionLabel={tSettings("rotate")}
        onAction={() => {
          const target = rotating;
          setRotating(null);
          if (target) void rotate(target);
        }}
      />
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={t("deleteTitle")}
        description={deleting ? t("deleteConfirm", { name: deleting.name }) : ""}
        actionLabel={tCommon("delete")}
        onAction={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void remove(target);
        }}
      />
    </VStack>
  );
}

function ConnectionDialog({
  connection,
  roles,
  isReadOnly,
  onClose,
  onSaved,
}: {
  /** Null makes a new connection. */
  connection: ScimConnection | null;
  roles: MappableRole[];
  isReadOnly: boolean;
  onClose: () => void;
  onSaved: (token: string | null) => void;
}) {
  const t = useTranslations("scim");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  const roleName = useRoleName();
  const [name, setName] = useState(connection?.name ?? "");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [linkExisting, setLinkExisting] = useState(connection?.linkExisting ?? true);
  const [groupNames, setGroupNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      roles.map((role) => [role.key, (connection?.roleGroups[role.key] ?? []).join(", ")]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const roleGroups = Object.fromEntries(
        roles.map((role) => [
          role.key,
          (groupNames[role.key] ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        ]),
      );
      const result = unwrap(
        await saveScimConnectionAction(connection?.id ?? null, {
          name,
          enabled,
          linkExisting,
          roleGroups,
        }),
      );
      onSaved(result.token);
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={connection ? connection.name : t("newTitle")}
      maxWidth="lg"
      {...(isReadOnly
        ? {}
        : {
            submitLabel: tCommon("save"),
            onSubmit: () => void save(),
            isSubmitting: saving,
            isSubmitDisabled: !name.trim(),
          })}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        <TextInput
          label={tCommon("name")}
          isRequired
          isDisabled={isReadOnly}
          size="sm"
          value={name}
          onChange={setName}
        />
        <Switch
          label={tSettings("enabled")}
          description={t("enabledHelp")}
          isDisabled={isReadOnly}
          value={enabled}
          onChange={setEnabled}
        />
        <Switch
          label={t("linkExisting")}
          description={t("linkExistingHelp")}
          isDisabled={isReadOnly}
          value={linkExisting}
          onChange={setLinkExisting}
        />
        <VStack gap={1}>
          <Text type="body" size="sm" weight="semibold">
            {tSettings("groupRoles")}
          </Text>
          <Text type="supporting" color="secondary">
            {t("roleMappingHelp")}
          </Text>
        </VStack>
        {roles.map((role) => (
          <TextInput
            key={role.key}
            label={roleName(role)}
            isOptional
            isDisabled={isReadOnly}
            size="sm"
            placeholder={t("groupNamesPlaceholder")}
            value={groupNames[role.key] ?? ""}
            onChange={(value) => setGroupNames((current) => ({ ...current, [role.key]: value }))}
          />
        ))}
      </VStack>
    </AppDialog>
  );
}
