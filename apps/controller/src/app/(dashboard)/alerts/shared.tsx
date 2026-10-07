"use client";

import { useTranslations } from "next-intl";
import { Token } from "@astryxdesign/core/Token";
import type { ChannelView } from "@/src/lib/alerts/channels";
import { settingLabel } from "@/src/lib/settings/messages";

export const SEVERITIES = ["critical", "warning", "info"] as const;

const SEVERITY_COLOR = { critical: "red", warning: "orange", info: "blue" } as const;

export function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SeverityToken({ severity }: { severity: string }) {
  const t = useTranslations("attention.severity");
  const known = severity in SEVERITY_COLOR ? (severity as keyof typeof SEVERITY_COLOR) : "info";
  return <Token size="sm" color={SEVERITY_COLOR[known]} label={t(known)} />;
}

/** A built-in rule is named by its Settings switch, so both pages call it the same. */
export function useRuleName() {
  const tRoot = useTranslations();
  return (rule: { name: string | null; settingKey: string | null }) =>
    rule.settingKey ? settingLabel(tRoot, rule.settingKey) : (rule.name ?? "");
}

/** The built-in channels are stored as "email" and "push"; shown in the reader's language. */
export function useChannelName() {
  const t = useTranslations("alerts.channels.kinds");
  return (channel: Pick<ChannelView, "name" | "builtin">) =>
    channel.builtin ? t(channel.builtin) : channel.name;
}
