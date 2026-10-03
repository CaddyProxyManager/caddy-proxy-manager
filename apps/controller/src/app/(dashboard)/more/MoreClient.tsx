"use client";

import { useTranslations } from "next-intl";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { List } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { PageHeader } from "@/components/ui/PageHeader";
import { DESTINATION_HUES, DESTINATION_ICONS } from "@/src/components/mobile/nav-icons";
import { ACCENTS } from "@/src/components/ui/accent";
import {
  type Destination,
  type DestinationId,
  MORE_DRAWER_SLOTS,
  MORE_GROUPS,
  type MoreGroup,
} from "@/src/lib/nav/destinations";

const GROUP_LABEL: Record<
  MoreGroup,
  "groupAccess" | "groupSecurity" | "groupReference" | "groupInstance"
> = {
  access: "groupAccess",
  security: "groupSecurity",
  reference: "groupReference",
  instance: "groupInstance",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <VStack gap={2}>
      <Text type="label" size="sm" color="secondary">
        {title}
      </Text>
      <Card padding={0}>{children}</Card>
    </VStack>
  );
}

export default function MoreClient({
  destinations,
  inDrawer,
}: {
  destinations: Destination[];
  inDrawer: DestinationId[];
}) {
  const t = useTranslations("nav");
  const tMore = useTranslations("nav.more");
  const pinned = new Set(inDrawer);

  return (
    <VStack gap={5}>
      <PageHeader title={tMore("title")} />

      {MORE_GROUPS.map((group) => {
        const items = destinations.filter((d) => d.moreGroup === group);
        if (items.length === 0) return null;
        return (
          <Section key={group} title={tMore(GROUP_LABEL[group])}>
            <List hasDividers>
              {items.map((item) => (
                <Item
                  key={item.id}
                  as="li"
                  href={item.href}
                  label={t(item.labelKey)}
                  startContent={
                    <Icon
                      icon={DESTINATION_ICONS[item.id]}
                      className={ACCENTS[DESTINATION_HUES[item.id]].text}
                    />
                  }
                  endContent={
                    pinned.has(item.id) ? (
                      <Badge variant="pink" label={tMore("inDrawer")} />
                    ) : (
                      <Icon icon={ChevronRight} size="sm" color="secondary" />
                    )
                  }
                />
              ))}
            </List>
          </Section>
        );
      })}

      <Section title={tMore("navigation")}>
        <List>
          <Item
            as="li"
            href="/more/customize"
            label={tMore("customize")}
            description={tMore("customizeMoreDescription", { max: MORE_DRAWER_SLOTS })}
            startContent={<Icon icon={SlidersHorizontal} color="secondary" />}
            endContent={<Icon icon={ChevronRight} size="sm" color="secondary" />}
          />
        </List>
      </Section>
    </VStack>
  );
}
