"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import { CheckboxInput } from "@/components/ui/FormBooleanControls";
import { startViewAsAction } from "@/src/app/(dashboard)/view-as/actions";

const ROLES = ["operator", "user", "viewer"] as const;

/**
 * Starts "View as" (lib/users/view-as.ts): any role but admin, in any groups, since a group's
 * grants reach a scoped role and the role a group gives reaches everyone in it.
 */
export function ViewAsDialog({
  open,
  onClose,
  groups,
  initialGroupIds = [],
  madeRoles = [],
}: {
  open: boolean;
  onClose: () => void;
  groups: { id: number; name: string }[];
  initialGroupIds?: number[];
  /** Roles made here, by key and name. */
  madeRoles?: readonly { key: string; name: string }[];
}) {
  const t = useTranslations("users.viewAs");
  const tCommon = useTranslations("common");
  const [role, setRole] = useState<string>("operator");
  const [groupIds, setGroupIds] = useState<number[]>(initialGroupIds);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    const result = await startViewAsAction(role, groupIds);
    setBusy(false);
    if (result.status === "error") {
      setError(result.message ?? null);
      return;
    }
    // A full load: the whole shell - menus, banner, every cached segment - changes with the role.
    window.location.assign("/");
  };

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("title")}
      maxWidth="sm"
      submitLabel={tCommon("view")}
      onSubmit={start}
      isSubmitting={busy}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("errorTitle")} description={error} />}
        <Text type="body" size="sm" color="secondary">
          {t("description")}
        </Text>
        <Selector
          label={tCommon("role")}
          options={[
            ...ROLES.map((value) => ({ value: value as string, label: t(`roles.${value}`) })),
            ...madeRoles.map((made) => ({ value: made.key, label: made.name })),
          ]}
          value={role}
          onChange={setRole}
        />
        <VStack gap={2}>
          <Text type="body" size="sm" weight="semibold">
            {t("groups")}
          </Text>
          {groups.length === 0 ? (
            <Text type="body" size="sm" color="secondary">
              {t("noGroups")}
            </Text>
          ) : (
            groups.map((group) => (
              <CheckboxInput
                key={group.id}
                label={group.name}
                value={groupIds.includes(group.id)}
                onChange={(checked) =>
                  setGroupIds((current) =>
                    checked ? [...current, group.id] : current.filter((id) => id !== group.id),
                  )
                }
              />
            ))
          )}
          <Text type="supporting">{t("groupsHelp")}</Text>
        </VStack>
      </VStack>
    </AppDialog>
  );
}
