"use client";

import { usePathname } from "next/navigation";
import type { RefObject } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { List } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { type Destination, MORE_DRAWER_SLOTS } from "@/src/lib/nav/destinations";
import { ACCENTS } from "@/src/components/ui/accent";
import { DESTINATION_HUES, DESTINATION_ICONS } from "./nav-icons";

/**
 * Without a scrim: a modal sheet makes the tab bar inert, so a second tap on More could never
 * land. `cpm-more-sheet` lifts the panel clear of the bar.
 */
export function MoreDrawer({
  isOpen,
  onClose,
  items,
  totalPages,
  offerCustomize,
  returnFocusRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  items: Destination[];
  /** How many pages All pages leads to, for its caption. */
  totalPages: number;
  /** Until the user has customized the drawer once. */
  offerCustomize: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("nav");
  const tMore = useTranslations("nav.more");
  const pathname = usePathname();

  return (
    <BottomSheet
      label={tMore("jumpTo")}
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      hasScrim={false}
      height="hug"
      finalFocusRef={returnFocusRef}
      className="cpm-more-sheet"
    >
      {/* Clear of the grab handle, which overlays the top of the content. */}
      <VStack gap={3} paddingInline={3} paddingBlockStart={6} paddingBlockEnd={4}>
        {/* A non-modal sheet moves no focus itself, and Escape only reaches it from inside. */}
        <Heading level={2} justify="center" tabIndex={-1} data-autofocus="">
          {tMore("jumpTo")}
        </Heading>
        {/* Three columns of three: eight pins and All pages fill it exactly. */}
        <Grid columns={3} gap={2}>
          {items.map((item) => {
            const isCurrent = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <ClickableCard
                key={item.id}
                label={t(item.labelKey)}
                href={item.href}
                onClick={onClose}
                padding={3}
                className="cpm-tile"
                data-current={isCurrent || undefined}
              >
                <VStack gap={2} hAlign="center">
                  <Icon
                    icon={DESTINATION_ICONS[item.id]}
                    size="lg"
                    className={ACCENTS[DESTINATION_HUES[item.id]].text}
                  />
                  <Text type="label" size="sm" justify="center">
                    {t(item.labelKey)}
                  </Text>
                </VStack>
              </ClickableCard>
            );
          })}
          <ClickableCard
            label={tMore("allPages")}
            href="/more"
            onClick={onClose}
            padding={3}
            variant="muted"
            className="cpm-tile"
          >
            <VStack gap={2} hAlign="center">
              <Icon icon={LayoutGrid} size="lg" color="secondary" />
              <VStack gap={0.5} hAlign="center">
                <Text type="label" size="sm" justify="center">
                  {tMore("allPages")}
                </Text>
                <Text type="supporting" justify="center">
                  {tMore("allPagesCount", { count: totalPages })}
                </Text>
              </VStack>
            </VStack>
          </ClickableCard>
        </Grid>
        {offerCustomize && (
          <List>
            <Item
              as="li"
              href="/more/customize"
              label={tMore("customize")}
              description={tMore("customizeDescription", { max: MORE_DRAWER_SLOTS })}
              startContent={<Icon icon={SlidersHorizontal} color="secondary" />}
              endContent={<Icon icon={ChevronRight} size="sm" color="secondary" />}
            />
          </List>
        )}
      </VStack>
    </BottomSheet>
  );
}
