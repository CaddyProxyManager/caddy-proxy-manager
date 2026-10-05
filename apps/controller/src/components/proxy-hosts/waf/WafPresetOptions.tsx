"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WafPresetOption = {
  id: number;
  name: string;
  description: string | null;
};
/** An installed CRS plugin, as a picker lists it. */
export type WafPluginOption = WafPresetOption;

type WafOptions = {
  presets: readonly WafPresetOption[];
  plugins: readonly WafPluginOption[];
};

// A context rather than a prop: WafFields sits several dialogs deep, and the docs site renders it
// with no page around it at all.
const WafPresetOptionsContext = createContext<WafOptions>({
  presets: [],
  plugins: [],
});

export function WafPresetOptionsProvider({
  presets,
  plugins = [],
  children,
}: {
  presets: readonly WafPresetOption[];
  plugins?: readonly WafPluginOption[];
  children: ReactNode;
}) {
  return (
    <WafPresetOptionsContext.Provider value={{ presets, plugins }}>
      {children}
    </WafPresetOptionsContext.Provider>
  );
}

export function useWafPresetOptions(): readonly WafPresetOption[] {
  return useContext(WafPresetOptionsContext).presets;
}

export function useWafPluginOptions(): readonly WafPluginOption[] {
  return useContext(WafPresetOptionsContext).plugins;
}
