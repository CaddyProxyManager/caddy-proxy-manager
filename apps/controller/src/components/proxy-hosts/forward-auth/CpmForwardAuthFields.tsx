"use client";

import { useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { useTranslations } from "next-intl";

type UserEntry = {
  id: number;
  email: string;
  name: string | null;
  role: string;
};

type GroupEntry = {
  id: number;
  name: string;
  description: string | null;
  member_count: number;
};

type ForwardAuthAccessData = {
  userIds: number[];
  groupIds: number[];
};

export function CpmForwardAuthFields({
  cpmForwardAuth,
  users = [],
  groups = [],
  currentAccess,
}: {
  cpmForwardAuth?: ProxyHost["cpmForwardAuth"] | null;
  users?: UserEntry[];
  groups?: GroupEntry[];
  currentAccess?: ForwardAuthAccessData | null;
}) {
  const t = useTranslations("proxyHosts");
  const initial = cpmForwardAuth ?? null;
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>(currentAccess?.userIds ?? []);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>(currentAccess?.groupIds ?? []);
  const [protectedPaths, setProtectedPaths] = useState(initial?.protected_paths?.join(", ") ?? "");
  const [excludedPaths, setExcludedPaths] = useState(initial?.excluded_paths?.join(", ") ?? "");
  const [requireCaptcha, setRequireCaptcha] = useState(initial?.require_captcha ?? true);

  const hasNoTargets = groups.length === 0 && users.length === 0;
  const hasNothingSelected =
    selectedGroupIds.length === 0 && selectedUserIds.length === 0 && !hasNoTargets;

  return (
    <Card>
      <input type="hidden" name="cpmForwardAuthPresent" value="1" />
      <input type="hidden" name="cpmForwardAuthEnabledPresent" value="1" />
      {enabled &&
        selectedUserIds.map((id) => (
          <input key={`faa-u-${id}`} type="hidden" name="cpmFaUserId" value={String(id)} />
        ))}
      {enabled &&
        selectedGroupIds.map((id) => (
          <input key={`faa-g-${id}`} type="hidden" name="cpmFaGroupId" value={String(id)} />
        ))}

      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("cpmForwardAuth")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("cpmForwardAuthDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableCpmForwardAuth")}
            isLabelHidden
            htmlName="cpmForwardAuthEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>

        {enabled && (
          <VStack gap={4}>
            <TextArea
              label={t("protectedPaths")}
              isOptional
              htmlName="cpmForwardAuthProtectedPaths"
              placeholder="/secret/*, /admin/*"
              value={protectedPaths}
              onChange={setProtectedPaths}
              rows={2}
              description={t("forwardAuthProtectedPathsHelp")}
            />
            <TextArea
              label={t("excludedPaths")}
              isOptional
              htmlName="cpmForwardAuthExcludedPaths"
              placeholder="/share/*, /rest/*"
              value={excludedPaths}
              onChange={setExcludedPaths}
              rows={2}
              description={t("forwardAuthExcludedPathsHelp")}
            />
            <Switch
              label={t("cpmForwardAuthRequireCaptcha")}
              description={t("cpmForwardAuthRequireCaptchaHelp")}
              htmlName="cpmForwardAuthRequireCaptcha"
              value={requireCaptcha}
              onChange={setRequireCaptcha}
            />

            {groups.length > 0 && (
              <CheckboxList
                label={t("allowedGroups")}
                hasDividers
                value={selectedGroupIds.map(String)}
                onChange={(values) => setSelectedGroupIds(values.map(Number))}
              >
                {groups.map((group) => (
                  <CheckboxListItem
                    key={group.id}
                    value={String(group.id)}
                    label={group.name}
                    description={group.description ?? undefined}
                    endContent={
                      <Badge label={t("groupMemberCount", { count: group.member_count })} />
                    }
                  />
                ))}
              </CheckboxList>
            )}

            {users.length > 0 && (
              <CheckboxList
                label={t("allowedUsers")}
                hasDividers
                value={selectedUserIds.map(String)}
                onChange={(values) => setSelectedUserIds(values.map(Number))}
              >
                {users.map((user) => (
                  <CheckboxListItem
                    key={user.id}
                    value={String(user.id)}
                    label={user.name ?? user.email.split("@")[0]}
                    description={user.email}
                  />
                ))}
              </CheckboxList>
            )}

            {hasNoTargets && (
              <EmptyState
                title={t("forwardAuthSubjectsEmptyTitle")}
                description={t("forwardAuthGroupsEmptyDescription")}
                isCompact
              />
            )}

            {hasNothingSelected && (
              <Banner
                status="warning"
                title={t("forwardAuthAccessDeniedTitle")}
                description={t("forwardAuthAccessDeniedDescription")}
              />
            )}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
