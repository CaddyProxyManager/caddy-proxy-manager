"use client";

/** Nothing ticked means every agent; the banner says so rather than leave "nowhere" a guess. */

import { useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

export type AgentOption = {
  id: number;
  name: string;
  connected: boolean;
  hasOwnBuildSettings: boolean;
};

export function AgentAssignmentFields({
  agents = [],
  selected = [],
}: {
  agents?: AgentOption[];
  selected?: number[];
}) {
  const t = useTranslations("agents");
  const tNav = useTranslations("nav");
  const [selectedIds, setSelectedIds] = useState<number[]>(selected);

  // No card, but still the marker: without it a cleared list looks like a form without the field.
  if (agents.length === 0) {
    return <input type="hidden" name="agentAssignmentPresent" value="1" />;
  }

  return (
    <Card>
      {/* The marker, not the values, for the reason above. */}
      <input type="hidden" name="agentAssignmentPresent" value="1" />
      {selectedIds.map((id) => (
        <input key={`agent-${id}`} type="hidden" name="agentId" value={String(id)} />
      ))}

      <VStack gap={4}>
        <VStack gap={1}>
          <Text type="body" size="sm" weight="semibold">
            {tNav("agents")}
          </Text>
          <Text type="body" size="sm" color="secondary">
            {t("assignmentDescription")}
          </Text>
        </VStack>

        <CheckboxList
          label={t("assignedAgents")}
          hasDividers
          value={selectedIds.map(String)}
          onChange={(values) => setSelectedIds(values.map(Number))}
        >
          {agents.map((agent) => (
            <CheckboxListItem
              key={agent.id}
              value={String(agent.id)}
              label={agent.name}
              description={agent.connected ? t("connected") : t("notConnected")}
              endContent={
                agent.hasOwnBuildSettings ? <Badge label={t("ownBuildBadge")} /> : undefined
              }
            />
          ))}
        </CheckboxList>

        {selectedIds.length === 0 && (
          <Banner status="info" title={t("assignedToAll")} description={t("assignedToAllHelp")} />
        )}
      </VStack>
    </Card>
  );
}
