"use client";

/**
 * The stages come from `lib/setup.ts` so the stepper cannot disagree with the redirects. `verify`
 * is a real stage though it lives at `/login`; `/setup/done` comes after setup, so is no step.
 */
import { Stepper, Step } from "@astryxdesign/core/Stepper";
import { useTranslations } from "next-intl";
import type { SetupStage } from "@/src/lib/setup";

/** The stages an operator walks, in order. `complete` is the absence of a step, not one. */
const STEP_ORDER = ["migrate", "account", "verify", "settings"] as const;

type StepStage = (typeof STEP_ORDER)[number];

export function SetupSteps({
  stage,
  hasMigrateStep,
}: {
  stage: SetupStage;
  /** A legacy database on the host is the only thing that adds the step. */
  hasMigrateStep: boolean;
}) {
  const t = useTranslations("setup.steps");
  const stages = STEP_ORDER.filter((entry) => entry !== "migrate" || hasMigrateStep);
  const active = stages.indexOf(stage as StepStage);

  // `complete` reaches this on /setup/done, where every step is behind the operator.
  const activeStep = active === -1 ? stages.length : active;

  return (
    <Stepper activeStep={activeStep} label={t("label")}>
      {stages.map((entry, index) => (
        <Step key={entry} step={index} label={t(entry)} />
      ))}
    </Stepper>
  );
}
