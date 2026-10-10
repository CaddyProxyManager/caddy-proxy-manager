"use client";
/**
 * The global WAF settings a host's WAF editor has to know: whether a risky custom directive is a
 * warning or an error there. In context, since the host dialogs open from several pages.
 */
import { createContext, useContext, type ReactNode } from "react";

export type WafPolicy = {
  strictDirectives: boolean;
};

// Lenient outside a provider: tests and the login shell never save a directive.
const WafPolicyContext = createContext<WafPolicy>({ strictDirectives: false });

export function WafPolicyProvider({ value, children }: { value: WafPolicy; children: ReactNode }) {
  return <WafPolicyContext.Provider value={value}>{children}</WafPolicyContext.Provider>;
}

export function useWafPolicy(): WafPolicy {
  return useContext(WafPolicyContext);
}
