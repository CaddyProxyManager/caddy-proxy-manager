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
 * Starts "View as" (lib/view-as.ts). Groups are only offered for an operator: grants reach no
 * other role, so a viewer in a group sees exactly what a viewer outside one does.
 */
export function ViewAsDialog({
  open,
  onClose,
  groups,
  initialGroupIds = [],
}: {
  open: boolean;
  onClose: () => void;
  groups: { id: number; name: string }[];
  initialGroupIds?: number[];
}) {
  const t = useTranslations("users.viewAs");
  const [role, setRole] = useState<(typeof ROLES)[number]>("operator");
  const [groupIds, setGroupIds] = useState<number[]>(initialGroupIds);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    const result = await startViewAsAction(role, role === "operator" ? groupIds : []);
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
      submitLabel={t("start")}
      onSubmit={start}
      isSubmitting={busy}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("errorTitle")} description={error} />}
        <Text type="body" size="sm" color="secondary">
          {t("description")}
        </Text>
        <Selector
          label={t("role")}
          options={ROLES.map((value) => ({ value, label: t(`roles.${value}`) }))}
          value={role}
          onChange={(next) => setRole(next as (typeof ROLES)[number])}
        />
        {role === "operator" && (
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
            <Text type="body" size="xsm" color="secondary">
              {t("groupsHelp")}
            </Text>
          </VStack>
        )}
      </VStack>
    </AppDialog>
  );
}
