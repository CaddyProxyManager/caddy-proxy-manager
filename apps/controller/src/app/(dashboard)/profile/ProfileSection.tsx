"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Stack";

export function ProfileSection({
  icon,
  title,
  action,
  id,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  /** An anchor, for links such as the two-factor banner's. */
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id}>
      <Card padding={6}>
        <VStack gap={4}>
          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
            <HStack gap={2} vAlign="center">
              <Icon icon={icon} color="accent" />
              <Heading level={2}>{title}</Heading>
            </HStack>
            {action}
          </HStack>
          <Divider />
          {children}
        </VStack>
      </Card>
    </section>
  );
}
