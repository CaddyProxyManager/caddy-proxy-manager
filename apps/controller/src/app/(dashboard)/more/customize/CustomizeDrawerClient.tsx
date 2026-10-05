"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  type Destination,
  type DestinationId,
  MORE_DRAWER_SLOTS,
  MORE_GROUPS,
  type MoreGroup,
} from "@/src/lib/nav/destinations";
import { saveMoreDrawerPinsAction } from "../actions";

/** Under `nav`, where the rail's groups are named too. */
const GROUP_LABEL: Record<
  MoreGroup,
  "railGroupAccess" | "security" | "more.groupReference" | "more.groupInstance"
> = {
  access: "railGroupAccess",
  security: "security",
  reference: "more.groupReference",
  instance: "more.groupInstance",
};

/**
 * Choose which pages the More drawer holds. Checking a page appends it, so the drawer shows the
 * pages in the order they were chosen - the ones picked first are the ones reached first.
 */
export default function CustomizeDrawerClient({
  destinations,
  initial,
}: {
  destinations: Destination[];
  initial: DestinationId[];
}) {
  const t = useTranslations("nav");
  const tMore = useTranslations("nav.more");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [chosen, setChosen] = useState<DestinationId[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  const isFull = chosen.length >= MORE_DRAWER_SLOTS;

  const toggle = (id: DestinationId, checked: boolean) => {
    setError(null);
    setChosen((current) =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((c) => c !== id),
    );
  };

  const save = () =>
    startSaving(async () => {
      const result = await saveMoreDrawerPinsAction(chosen);
      // A server action whose request never reached the action - a redirect in front of it, a
      // dropped connection - resolves to undefined rather than rejecting. Treat that as the
      // failure it is instead of reading `.ok` off nothing and losing the page to the error.
      if (!result?.ok) {
        setError(result?.error ?? tMore("errorSaveFailed"));
        return;
      }
      router.push("/more");
    });

  return (
    <VStack gap={5}>
      <PageHeader title={tMore("customizeTitle")} />

      {/* Above the list, not at its foot: Done is what you reach for once the boxes are ticked, and
          the list is long enough on a phone to put the foot below the fold. */}
      <HStack justify="between" vAlign="center" gap={3}>
        <Text type="body" size="sm" color="secondary">
          {tMore("chosenCount", {
            count: chosen.length,
            total: destinations.length,
            max: MORE_DRAWER_SLOTS,
          })}
        </Text>
        <Button
          variant="primary"
          label={isSaving ? tMore("saving") : tCommon("done")}
          isLoading={isSaving}
          onClick={save}
        />
      </HStack>

      {error && <Banner status="error" title={error} />}

      {MORE_GROUPS.map((group) => {
        const items = destinations.filter((d) => d.moreGroup === group);
        if (items.length === 0) return null;
        return (
          <VStack key={group} gap={2}>
            <Text type="label" size="sm" color="secondary">
              {t(GROUP_LABEL[group])}
            </Text>
            <Card>
              <VStack gap={3}>
                {items.map((item) => {
                  const isChecked = chosen.includes(item.id);
                  return (
                    <CheckboxInput
                      key={item.id}
                      label={t(item.labelKey)}
                      value={isChecked}
                      onChange={(checked) => toggle(item.id, checked)}
                      // Full is a limit on adding, never on removing - an unchecked box is locked,
                      // a checked one always stays free to clear.
                      isDisabled={isSaving || (isFull && !isChecked)}
                      disabledMessage={isFull && !isChecked ? tMore("limitReached") : undefined}
                    />
                  );
                })}
              </VStack>
            </Card>
          </VStack>
        );
      })}
    </VStack>
  );
}
