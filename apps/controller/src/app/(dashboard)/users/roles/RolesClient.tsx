"use client";

/**
 * The roles: the four built-in ones, read only, and the ones made here. A role's permissions are
 * one choice per area, none, read or read and change, so a write can never be ticked without its
 * read.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ArrowLeft, MoreHorizontal, Plus } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { AppDialog } from "@/components/ui/AppDialog";
import { useTableDensity } from "@/components/ui/TableDensity";
import {
  CAPABILITY_RESOURCE_LIST,
  type Capability,
  type CapabilityResource,
  normalizeCapabilities,
} from "@/src/lib/roles/capabilities";
import { deleteRoleAction, saveRoleAction } from "./actions";

export type RoleView = {
  key: string;
  name: string | null;
  description: string | null;
  capabilities: Capability[];
  scoped: boolean;
  builtIn: boolean;
};

type Level = "none" | "read" | "write";

const BUILT_IN = ["admin", "operator", "user", "viewer"] as const;
type BuiltIn = (typeof BUILT_IN)[number];

function levelOf(capabilities: readonly Capability[], resource: CapabilityResource): Level {
  if (capabilities.includes(`${resource}:write`)) return "write";
  return capabilities.includes(`${resource}:read`) ? "read" : "none";
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Names from the catalog for the built-in roles, and from the role for the rest. */
function useRoleName() {
  const tUsers = useTranslations("users");
  return (role: RoleView) =>
    role.builtIn && (BUILT_IN as readonly string[]).includes(role.key)
      ? tUsers(`roles.${role.key as BuiltIn}`)
      : (role.name ?? role.key);
}

export default function RolesClient({
  roles,
  canWrite,
  holdsKey,
}: {
  roles: RoleView[];
  /** Holds roles:write: may make and change roles, within what they hold themselves. */
  canWrite: boolean;
  /** The viewer's own role, which they may not change or delete. */
  holdsKey: string;
}) {
  const t = useTranslations("roles");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  // The same count a token's chosen permissions are shown with.
  const tScope = useTranslations("profile.apiTokenScope");
  const router = useRouter();
  const density = useTableDensity();
  const roleName = useRoleName();
  const [editing, setEditing] = useState<RoleView | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RoleView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(role: RoleView) {
    setError(null);
    try {
      await deleteRoleAction(role.key);
    } catch (err) {
      setError(message(err, t("deleteFailed")));
    } finally {
      router.refresh();
    }
  }

  type Row = RoleView & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold" maxLines={1}>
            {roleName(row)}
          </Text>
          <Text type="supporting" color="secondary" maxLines={2}>
            {row.builtIn ? t(`builtInHelp.${row.key as BuiltIn}`) : (row.description ?? "")}
          </Text>
        </VStack>
      ),
    },
    {
      key: "kind",
      header: t("kind"),
      width: pixel(160),
      renderCell: (row) => (
        <HStack gap={1} wrap="wrap">
          {row.builtIn && <Token size="sm" color="purple" label={t("builtIn")} />}
          {row.scoped && <Token size="sm" color="blue" label={t("scopedShort")} />}
        </HStack>
      ),
    },
    {
      key: "permissions",
      header: t("permissions"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          {row.capabilities.length === 0
            ? t("signsInOnly")
            : tScope("customCount", { count: row.capabilities.length })}
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
            label: tCommon("actionsFor", { name: roleName(row) }),
            isIconOnly: true,
          }}
          items={[
            {
              id: "view",
              label:
                canWrite && !row.builtIn && row.key !== holdsKey
                  ? tCommon("edit")
                  : tCommon("view"),
              onClick: () => setEditing(row),
            },
            ...(canWrite && !row.builtIn && row.key !== holdsKey
              ? [
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
          {canWrite && (
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
      {error && <Banner status="error" title={t("deleteFailed")} description={error} />}
      <Card padding={0}>
        <Table
          density={density}
          data={roles.map((role) => ({ ...role }))}
          columns={columns}
          idKey="key"
          hasHover
        />
      </Card>

      {/* Mounted only while open: a closed form would still answer its labels to tests and AT. */}
      {(creating || editing) && (
        <RoleDialog
          role={editing}
          isReadOnly={
            editing !== null && (!canWrite || editing.builtIn || editing.key === holdsKey)
          }
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => router.refresh()}
        />
      )}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={t("deleteTitle")}
        description={deleting ? t("deleteConfirm", { name: roleName(deleting) }) : ""}
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

function RoleDialog({
  role,
  isReadOnly,
  onClose,
  onSaved,
}: {
  /** Null makes a new role. */
  role: RoleView | null;
  isReadOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("roles");
  const tCommon = useTranslations("common");
  const tAccess = useTranslations("profile.apiTokenAccess");
  const roleName = useRoleName();
  const [name, setName] = useState(role?.builtIn ? "" : (role?.name ?? ""));
  const [description, setDescription] = useState(role?.description ?? "");
  const [scoped, setScoped] = useState(role?.scoped ?? false);
  const [levels, setLevels] = useState<Record<CapabilityResource, Level>>(
    () =>
      Object.fromEntries(
        CAPABILITY_RESOURCE_LIST.map((resource) => [
          resource,
          levelOf(role?.capabilities ?? [], resource),
        ]),
      ) as Record<CapabilityResource, Level>,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capabilities = normalizeCapabilities(
    CAPABILITY_RESOURCE_LIST.flatMap((resource) =>
      levels[resource] === "none" ? [] : [`${resource}:${levels[resource]}`],
    ),
  );

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveRoleAction(role?.key ?? null, { name, description, capabilities, scoped });
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  type Row = { key: CapabilityResource; [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "area",
      header: t("area"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold">
            {t(`resources.${row.key}.label`)}
          </Text>
          <Text type="supporting" color="secondary">
            {t(`resources.${row.key}.help`)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "level",
      header: t("access"),
      width: pixel(280),
      renderCell: (row) => (
        <SegmentedControl
          label={t(`resources.${row.key}.label`)}
          size="sm"
          layout="fill"
          isDisabled={isReadOnly}
          value={levels[row.key]}
          onChange={(value) => setLevels((current) => ({ ...current, [row.key]: value as Level }))}
        >
          {(["none", "read", "write"] as const).map((level) => (
            <SegmentedControlItem key={level} value={level} label={tAccess(level)} />
          ))}
        </SegmentedControl>
      ),
    },
  ];

  return (
    <AppDialog
      open
      onClose={onClose}
      title={role ? roleName(role) : t("newTitle")}
      maxWidth="xl"
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
        {role?.builtIn && <Banner status="info" title={t("builtInLocked")} />}
        {!role?.builtIn && (
          <>
            <TextInput
              label={tCommon("name")}
              isRequired
              isDisabled={isReadOnly}
              size="sm"
              value={name}
              onChange={setName}
            />
            <TextArea
              label={tCommon("description")}
              isOptional
              isDisabled={isReadOnly}
              size="sm"
              rows={2}
              value={description}
              onChange={setDescription}
            />
          </>
        )}
        <Switch
          label={t("scoped")}
          description={t("scopedHelp")}
          isDisabled={isReadOnly}
          value={scoped}
          onChange={setScoped}
        />
        <Table
          data={CAPABILITY_RESOURCE_LIST.map((key) => ({ key }))}
          columns={columns}
          idKey="key"
        />
        {!isReadOnly && <Text type="supporting">{t("holdsOnly")}</Text>}
      </VStack>
    </AppDialog>
  );
}
