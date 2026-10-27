"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Stack";

/** A titled card on a host's overview, with an optional action at its right. */
export function SectionCard({
  icon,
  title,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card padding={5}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <HStack gap={2} vAlign="center">
            <Icon icon={icon} size="sm" color="accent" />
            <Heading level={2} accessibilityLevel={2}>
              {title}
            </Heading>
          </HStack>
          {action}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}
