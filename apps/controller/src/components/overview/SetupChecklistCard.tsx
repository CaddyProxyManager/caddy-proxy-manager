"use client";

/**
 * First steps for a new instance, administrators only. A step is ticked when it is detected or
 * marked done; the list hides itself only when asked to, never by finishing.
 */

import { useEffect, useState, useTransition } from "react";
import { Circle, CircleCheck, Rocket } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import {
  loadSetupChecklistAction,
  setSetupChecklistHiddenAction,
  setSetupStepDoneAction,
} from "@/src/app/(dashboard)/overview-actions";
import {
  SETUP_STEP_HREF,
  type SetupChecklist,
  type SetupStep,
  stepComplete,
} from "@/lib/setup-checklist/steps";

export function SetupChecklistCard({ preview }: { preview?: SetupChecklist }) {
  const t = useTranslations("overview.checklist");
  const [checklist, setChecklist] = useState<SetupChecklist | null>(preview ?? null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (preview) return;
    let live = true;
    loadSetupChecklistAction()
      .then((loaded) => {
        if (live) setChecklist(loaded);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [preview]);

  if (!checklist || checklist.hidden) return null;

  const complete = checklist.steps.filter(stepComplete).length;

  function markDone(step: SetupStep, done: boolean) {
    setChecklist((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((s) => (s.step === step ? { ...s, markedDone: done } : s)),
          }
        : current,
    );
    if (preview) return;
    startTransition(async () => {
      const result = await setSetupStepDoneAction(step, done);
      setError(result.status === "error" ? (result.message ?? null) : null);
    });
  }

  function hide() {
    setChecklist((current) => (current ? { ...current, hidden: true } : current));
    if (preview) return;
    startTransition(async () => {
      const result = await setSetupChecklistHiddenAction(true);
      if (result.status === "error") {
        setChecklist((current) => (current ? { ...current, hidden: false } : current));
        setError(result.message ?? null);
      }
    });
  }

  return (
    <Card padding={5}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <HStack gap={2} vAlign="center">
            <Icon icon={Rocket} size="sm" color="accent" />
            <Heading level={2} accessibilityLevel={2}>
              {t("title")}
            </Heading>
          </HStack>
          <Button
            variant="ghost"
            size="sm"
            label={t("hide")}
            onClick={hide}
            isDisabled={isPending}
          />
        </HStack>
        <ProgressBar
          label={t("progress", { done: complete, total: checklist.steps.length })}
          isLabelHidden
          value={complete}
          max={checklist.steps.length}
          variant={complete === checklist.steps.length ? "success" : "accent"}
          hasValueLabel
          formatValueLabel={() => t("progress", { done: complete, total: checklist.steps.length })}
        />
        {error && <Banner status="error" title={error} />}
        <List hasDividers density="compact">
          {checklist.steps.map((step) => {
            const isComplete = stepComplete(step);
            return (
              <ListItem
                key={step.step}
                label={t(`steps.${step.step}.title`)}
                description={
                  step.detected
                    ? t("detected")
                    : step.markedDone
                      ? t("markedDone")
                      : t(`steps.${step.step}.description`)
                }
                startContent={
                  <Icon
                    icon={isComplete ? CircleCheck : Circle}
                    size="sm"
                    color={isComplete ? "success" : "secondary"}
                  />
                }
                endContent={
                  <HStack gap={1} vAlign="center">
                    {!isComplete && (
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t(`steps.${step.step}.action`)}
                        href={SETUP_STEP_HREF[step.step]}
                      />
                    )}
                    {!step.detected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={step.markedDone ? t("undo") : t("markDone")}
                        onClick={() => markDone(step.step, !step.markedDone)}
                        isDisabled={isPending}
                      />
                    )}
                  </HStack>
                }
              />
            );
          })}
        </List>
      </VStack>
    </Card>
  );
}
