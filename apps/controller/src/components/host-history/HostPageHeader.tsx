"use client";

import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";

/** Above each of a host's pages but the overview: back to the list, its name, then its tabs. */
export function HostPageHeader({
  title,
  badge,
  listHref,
  listLabel,
  tabs,
}: {
  title: string;
  badge?: ReactNode;
  listHref: string;
  listLabel: string;
  tabs: ReactNode;
}) {
  return (
    <VStack gap={2}>
      <HStack>
        <Button variant="ghost" size="sm" icon={<ArrowLeft />} label={listLabel} href={listHref} />
      </HStack>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Heading level={1}>{title}</Heading>
        {badge}
      </HStack>
      {tabs}
    </VStack>
  );
}
