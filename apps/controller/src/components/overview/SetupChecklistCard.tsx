"use client";

/**
 * First steps for a new instance, administrators only. A step is ticked when it is detected or
 * marked done; the list hides itself only when asked to, never by finishing.
 */

import { useEffect, useState, useTransition } from "react";
import { Rocket } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
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
  // Steps finish in any order: the Stepper fills up to the first open one, and a step done
  // past it gets its check from `status`.
  const firstOpen = checklist.steps.findIndex((step) => !stepComplete(step));
  const activeStep = firstOpen === -1 ? checklist.steps.length : firstOpen;

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
        <Text type="supporting">
          {t("progress", { done: complete, total: checklist.steps.length })}
        </Text>
        {error && <Banner status="error" title={error} />}
        <Stepper activeStep={activeStep} orientation="vertical" label={t("title")}>
          {checklist.steps.map((step, index) => {
            const isComplete = stepComplete(step);
            return (
              <Step
                key={step.step}
                step={index}
                label={t(`steps.${step.step}.title`)}
                description={
                  step.detected
                    ? t("detected")
                    : step.markedDone
                      ? t("markedDone")
                      : t(`steps.${step.step}.description`)
                }
                status={isComplete ? "success" : undefined}
              >
                {!step.detected && (
                  <HStack gap={1} vAlign="center" wrap="wrap">
                    {!isComplete && (
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t(`steps.${step.step}.action`)}
                        href={SETUP_STEP_HREF[step.step]}
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      label={step.markedDone ? t("undo") : t("markDone")}
                      onClick={() => markDone(step.step, !step.markedDone)}
                      isDisabled={isPending}
                    />
                  </HStack>
                )}
              </Step>
            );
          })}
        </Stepper>
      </VStack>
    </Card>
  );
}
