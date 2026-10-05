/** The checklist's shape, client safe. */

export const SETUP_STEPS = ["certificate", "proxyHost", "analytics", "secondUser", "sso"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && (SETUP_STEPS as readonly string[]).includes(value);
}

/** Per instance. */
export type SetupChecklistState = { hidden: boolean; done: SetupStep[] };

export type SetupChecklistStep = {
  step: SetupStep;
  detected: boolean;
  markedDone: boolean;
};

export type SetupChecklist = { hidden: boolean; steps: SetupChecklistStep[] };

export function stepComplete(step: SetupChecklistStep): boolean {
  return step.detected || step.markedDone;
}

/** Where each step is done. */
export const SETUP_STEP_HREF: Record<SetupStep, string> = {
  certificate: "/certificates",
  proxyHost: "/proxy-hosts",
  analytics: "/settings/observability#analytics",
  secondUser: "/users",
  sso: "/settings/authentication#oauth",
};
