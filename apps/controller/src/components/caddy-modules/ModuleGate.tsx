"use client";

/**
 * Which plugin-backed features are on, in context for the dashboard's client components. Honesty,
 * not enforcement - config generation already refuses handlers for absent modules.
 */

import { createContext, useContext, type ReactNode } from "react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useTranslations } from "next-intl";
import type { CaddyFeatureId } from "@/src/lib/caddy/image-build/modules";

export type ModuleGateState = {
  /** Feature -> whether the admin has its module(s) selected. */
  features: Record<CaddyFeatureId, boolean>;
  /** Feature -> human-readable module name(s) to name in the tooltip. */
  moduleNames: Record<CaddyFeatureId, string>;
  /** Module ids the admin selected. `null` = unknown (no provider above); `[]` = all disabled. */
  enabledModuleIds: string[] | null;
  /** True when the selection has not been built into the image yet. */
  pendingRebuild: boolean;
};

// Defaulting to "everything on" keeps components usable outside the provider - tests, storybook
// and the login shell - instead of silently disabling every control.
const FALLBACK: ModuleGateState = {
  features: {
    l4: true,
    geoblock: true,
    waf: true,
    tailscale: true,
    dns01: true,
    cache: true,
    ratelimit: true,
    crowdsec: true,
  },
  moduleNames: {
    l4: "",
    geoblock: "",
    waf: "",
    tailscale: "",
    dns01: "",
    cache: "",
    ratelimit: "",
    crowdsec: "",
  },
  enabledModuleIds: null,
  pendingRebuild: false,
};

const ModuleGateContext = createContext<ModuleGateState>(FALLBACK);

export function ModuleGateProvider({
  value,
  children,
}: {
  value: ModuleGateState;
  children: ReactNode;
}) {
  return <ModuleGateContext.Provider value={value}>{children}</ModuleGateContext.Provider>;
}

export function useModuleGate(): ModuleGateState {
  return useContext(ModuleGateContext);
}

/** Whether one module is selected. Outside a provider (null) everything reads as enabled. */
export function useModuleEnabled(moduleId: string): boolean {
  const { enabledModuleIds } = useModuleGate();
  if (enabledModuleIds === null) return true;
  return enabledModuleIds.includes(moduleId);
}

/** Whether a feature's controls should be live. */
export function useFeatureEnabled(feature: CaddyFeatureId): boolean {
  return useModuleGate().features[feature] ?? true;
}

/** The sentence shown when a feature is off - names the module. Null when it is available. */
export function useDisabledReason(feature: CaddyFeatureId): string | null {
  const t = useTranslations("caddyModules");
  const gate = useModuleGate();
  if (gate.features[feature] ?? true) return null;
  const name = gate.moduleNames[feature];
  return name ? t("disabledReasonNamed", { name }) : t("disabledReasonUnnamed");
}

/**
 * Wrap controls that depend on a Caddy module: children untouched when on, tooltipped when off.
 * Callers disable their own inputs.
 */
export function ModuleGated({
  feature,
  children,
}: {
  feature: CaddyFeatureId;
  children: ReactNode;
}) {
  const reason = useDisabledReason(feature);
  if (!reason) return <>{children}</>;
  return <Tooltip content={reason}>{children}</Tooltip>;
}
