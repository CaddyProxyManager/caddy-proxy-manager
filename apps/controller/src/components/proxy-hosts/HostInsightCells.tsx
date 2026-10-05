"use client";

/**
 * The host list's traffic-aware cells, shared with the host page and the docs demo. Presentational:
 * the numbers come from `lib/proxy-hosts/list-insights`.
 */

import {
  Bot,
  Bug,
  Gauge,
  KeyRound,
  LogIn,
  MapPin,
  Shield,
  ShieldAlert,
  UserCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useFormatter, useTranslations } from "next-intl";
import { ACCENTS } from "@/components/ui/accent";
import { StatusChip } from "@/components/ui/StatusChip";
import { useEmptyValue } from "@/components/ui/empty-value";
import type { HostProtections, Protection } from "@/lib/proxy-hosts/protections";
import type { HostProblemCode, HostStatus } from "@/lib/proxy-hosts/traffic-status";

type ProtectionLabelKey =
  | "insights.protection.waf"
  | "insights.protection.signInCpm"
  | "insights.protection.signInAuthentik"
  | "insights.protection.signInForwardAuth"
  | "insights.protection.accessList"
  | "insights.protection.mtls"
  | "insights.protection.rateLimit"
  | "insights.protection.geo"
  | "insights.protection.crowdsec"
  | "insights.protection.botChallenge";

const PROTECTION_ICON: Record<Protection, ReactNode> = {
  waf: <Bug />,
  signIn: <LogIn />,
  accessList: <Shield />,
  mtls: <KeyRound />,
  rateLimit: <Gauge />,
  geo: <MapPin />,
  crowdsec: <ShieldAlert />,
  botChallenge: <Bot />,
};

function protectionLabelKey(key: Protection, protections: HostProtections): ProtectionLabelKey {
  if (key === "signIn") {
    if (protections.signIn === "authentik") return "insights.protection.signInAuthentik";
    if (protections.signIn === "forwardAuth") return "insights.protection.signInForwardAuth";
    return "insights.protection.signInCpm";
  }
  return `insights.protection.${key}`;
}

export function HostProtectionBadges({ protections }: { protections: HostProtections }) {
  const t = useTranslations("proxyHosts");
  const emptyValue = useEmptyValue();
  if (protections.active.length === 0) {
    return (
      <Text type="body" size="sm" color="secondary">
        {emptyValue}
      </Text>
    );
  }
  return (
    <HStack gap={1} wrap="wrap">
      {protections.active.map((key) => {
        const badge = (
          <Badge
            key={key}
            icon={
              key === "signIn" && protections.signIn === "authentik" ? (
                <UserCheck />
              ) : (
                PROTECTION_ICON[key]
              )
            }
            label={t(protectionLabelKey(key, protections))}
          />
        );
        // "ACL" is short for the column's sake; the hover spells it out.
        return key === "accessList" ? (
          <Tooltip key={key} content={t("insights.protection.accessListTitle")}>
            {badge}
          </Tooltip>
        ) : (
          badge
        );
      })}
    </HStack>
  );
}

/** Requests, a bar against the busiest host, and what was blocked. */
export function HostRequestsCell({
  requests,
  blocked,
  share,
}: {
  requests: number;
  blocked: number;
  share: number;
}) {
  const t = useTranslations("proxyHosts");
  const format = useFormatter();
  return (
    <VStack gap={1} className="cpm-cell-lines">
      <HStack gap={2} vAlign="center" justify="end">
        <Text type="code" size="sm">
          {format.number(requests)}
        </Text>
      </HStack>
      <ProgressBar
        label={t("insights.requestsShare", {
          share: format.number(share, { style: "percent", maximumFractionDigits: 0 }),
        })}
        isLabelHidden
        value={Math.round(share * 100)}
        variant="accent"
      />
      {blocked > 0 && (
        <Text type="supporting" color="secondary">
          {t("blockedCount", { count: format.number(blocked) })}
        </Text>
      )}
    </VStack>
  );
}

export function HostServerErrorsCell({
  serverErrors,
  requests,
}: {
  serverErrors: number;
  requests: number;
}) {
  const format = useFormatter();
  const emptyValue = useEmptyValue();
  if (serverErrors === 0) {
    return (
      <Text type="code" size="sm" color="secondary">
        {requests > 0 ? "0" : emptyValue}
      </Text>
    );
  }
  return (
    <VStack gap={0} hAlign="end" className="cpm-cell-lines">
      <Text type="code" size="sm" className={ACCENTS.red.text}>
        {format.number(serverErrors)}
      </Text>
      <Text type="supporting" color="secondary">
        {format.number(serverErrors / Math.max(1, requests), {
          style: "percent",
          maximumFractionDigits: 1,
        })}
      </Text>
    </VStack>
  );
}

type ProblemLabelKey = `insights.problem.${HostProblemCode}`;

export function HostStatusCell({ status }: { status: HostStatus }) {
  const t = useTranslations("proxyHosts");
  switch (status.state) {
    case "disabled":
      return <StatusChip status="inactive" label={t("insights.state.disabled")} />;
    case "maintenance":
      return <StatusChip status="warning" label={t("maintenanceToken")} />;
    case "healthy":
      return <StatusChip status="active" label={t("insights.state.healthy")} />;
    case "problem": {
      const key: ProblemLabelKey = `insights.problem.${status.problem!.code}`;
      return (
        <StatusChip
          status={status.problem!.severity === "info" ? "warning" : "error"}
          label={t(key)}
        />
      );
    }
  }
}

export function CertificateDaysCell({
  days,
  name,
}: {
  days: number | null;
  /** Shown on hover, where the list has room for only the number. */
  name?: string | null;
}) {
  const t = useTranslations("proxyHosts");
  const emptyValue = useEmptyValue();
  if (days === null) {
    return (
      <Text type="body" size="sm" color="secondary">
        {emptyValue}
      </Text>
    );
  }
  const text =
    days < 0 ? t("insights.certificateExpired") : t("insights.certificateDaysLeft", { days });
  const cell = (
    <Text
      type="body"
      size="sm"
      color={days < 14 ? undefined : "secondary"}
      className={days < 0 ? ACCENTS.red.text : days < 14 ? ACCENTS.orange.text : undefined}
    >
      {text}
    </Text>
  );
  return name ? <Tooltip content={name}>{cell}</Tooltip> : cell;
}
