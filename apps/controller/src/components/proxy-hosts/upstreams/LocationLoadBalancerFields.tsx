"use client";

import { Clock, EthernetPort, KeyRound, Route } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { LoadBalancerConfig, LoadBalancingPolicy } from "@/lib/models/proxy-hosts";
import { useTranslations } from "next-intl";

/** A function because the labels live in the message catalog. */
function loadBalancingPolicies(
  t: ReturnType<typeof useTranslations<"proxyHosts">>,
): { value: LoadBalancingPolicy; label: string }[] {
  return [
    { value: "random", label: t("lbPolicyRandomDefault") },
    { value: "random_choose", label: t("lbPolicyRandomChoose") },
    { value: "round_robin", label: t("lbPolicyRoundRobin") },
    { value: "weighted_round_robin", label: t("lbPolicyWeightedRoundRobin") },
    { value: "least_conn", label: t("lbPolicyLeastConn") },
    { value: "ip_hash", label: t("lbPolicyIpHash") },
    { value: "client_ip_hash", label: t("lbPolicyClientIpHash") },
    { value: "first", label: t("lbPolicyFirst") },
    { value: "header", label: t("lbPolicyHeader") },
    { value: "cookie", label: t("lbPolicyCookie") },
    { value: "uri_hash", label: t("lbPolicyUriHash") },
    { value: "query", label: t("lbPolicyQuery") },
  ];
}

export const EMPTY_LOAD_BALANCER: LoadBalancerConfig = {
  enabled: true,
  policy: "random",
  policyHeaderField: null,
  policyCookieName: null,
  policyCookieSecret: null,
  policyQueryKey: null,
  policyChoose: null,
  policyWeights: null,
  tryDuration: null,
  tryInterval: null,
  retries: null,
  activeHealthCheck: null,
  passiveHealthCheck: null,
};

const EMPTY_ACTIVE = {
  enabled: true,
  uri: null,
  port: null,
  interval: null,
  timeout: null,
  status: null,
  body: null,
  passes: null,
  fails: null,
  method: null,
  requestBody: null,
  followRedirects: false,
  headers: null,
};
const EMPTY_PASSIVE = {
  enabled: true,
  failDuration: null,
  maxFails: null,
  unhealthyStatus: null,
  unhealthyLatency: null,
  unhealthyRequestCount: null,
};

/** Positional against the upstream list. */
function parseWeightList(value: string): number[] | null {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const weights = parts.map((part) => Number.parseInt(part, 10));
  return weights.every((w) => Number.isInteger(w) && w >= 0) ? weights : null;
}

function str(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

type Props = {
  value: LoadBalancerConfig | null;
  onChange: (value: LoadBalancerConfig | null) => void;
};

/** LoadBalancerFields for one location rule, driven through onChange. */
export function LocationLoadBalancerFields({ value, onChange }: Props) {
  const t = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  const lb = value;
  const enabled = Boolean(lb?.enabled);
  const policy = lb?.policy ?? "random";
  const patch = (changes: Partial<LoadBalancerConfig>) =>
    onChange({ ...(lb ?? EMPTY_LOAD_BALANCER), ...changes });

  return (
    <Card variant="muted">
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={3}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("loadBalancer")}
            </Text>
            <Text type="supporting">{t("locationLoadBalancerDescription")}</Text>
          </VStack>
          <Switch
            label={t("locationLoadBalancerLabel")}
            isLabelHidden
            value={enabled}
            onChange={(on) =>
              onChange(on ? { ...(lb ?? EMPTY_LOAD_BALANCER), enabled: true } : null)
            }
          />
        </HStack>

        {enabled && (
          <VStack gap={4}>
            <Selector
              label={t("selectionPolicy")}
              size="sm"
              options={loadBalancingPolicies(t)}
              value={policy}
              onChange={(next) => patch({ policy: next as LoadBalancingPolicy })}
            />

            {policy === "random_choose" && (
              <NumberInput
                hasNumberSteppers
                label={t("lbChoose")}
                description={t("lbChooseHelp")}
                size="sm"
                value={lb?.policyChoose ?? undefined}
                onChange={(next) => patch({ policyChoose: next ?? null })}
              />
            )}

            {policy === "weighted_round_robin" && (
              <TextInput
                label={t("lbWeights")}
                description={t("lbWeightsHelp")}
                size="sm"
                placeholder="3, 2, 1"
                value={lb?.policyWeights?.join(", ") ?? ""}
                onChange={(next) => patch({ policyWeights: parseWeightList(next) })}
              />
            )}

            {policy === "query" && (
              <TextInput
                label={t("lbQueryKey")}
                description={t("lbQueryKeyHelp")}
                size="sm"
                placeholder={t("lbQueryKeyPlaceholder")}
                value={lb?.policyQueryKey ?? ""}
                onChange={(next) => patch({ policyQueryKey: str(next) })}
              />
            )}

            {policy === "header" && (
              <TextInput
                label={t("headerFieldName")}
                size="sm"
                placeholder={t("loadBalancerHeaderPlaceholder")}
                value={lb?.policyHeaderField ?? ""}
                onChange={(next) => patch({ policyHeaderField: str(next) })}
              />
            )}

            {policy === "cookie" && (
              <Grid columns={2} gap={3}>
                <TextInput
                  label={t("cookieName")}
                  size="sm"
                  placeholder="server_id"
                  value={lb?.policyCookieName ?? ""}
                  onChange={(next) => patch({ policyCookieName: str(next) })}
                />
                <TextInput
                  startIcon={KeyRound}
                  label={t("cookieSecret")}
                  isOptional
                  size="sm"
                  placeholder={t("stickyCookieSecretPlaceholder")}
                  value={lb?.policyCookieSecret ?? ""}
                  onChange={(next) => patch({ policyCookieSecret: str(next) })}
                />
              </Grid>
            )}

            <Grid columns={3} gap={3}>
              <TextInput
                startIcon={Clock}
                label={t("tryDuration")}
                size="sm"
                placeholder="5s"
                value={lb?.tryDuration ?? ""}
                onChange={(next) => patch({ tryDuration: str(next) })}
              />
              <TextInput
                startIcon={Clock}
                label={t("tryInterval")}
                size="sm"
                placeholder="250ms"
                value={lb?.tryInterval ?? ""}
                onChange={(next) => patch({ tryInterval: str(next) })}
              />
              <NumberInput
                hasNumberSteppers
                label={t("maxRetries")}
                size="sm"
                min={0}
                isIntegerOnly
                value={lb?.retries ?? null}
                onChange={(next) => patch({ retries: next })}
              />
            </Grid>

            <Card variant="muted">
              <VStack gap={3}>
                <Switch
                  label={t("activeHealthChecks")}
                  value={Boolean(lb?.activeHealthCheck?.enabled)}
                  onChange={(on) =>
                    patch({
                      activeHealthCheck: on
                        ? { ...(lb?.activeHealthCheck ?? EMPTY_ACTIVE), enabled: true }
                        : null,
                    })
                  }
                />
                {lb?.activeHealthCheck?.enabled && (
                  <Grid columns={2} gap={3}>
                    <TextInput
                      startIcon={Route}
                      label={t("uri")}
                      size="sm"
                      placeholder="/health"
                      value={lb.activeHealthCheck.uri ?? ""}
                      onChange={(next) =>
                        patch({ activeHealthCheck: { ...lb.activeHealthCheck!, uri: str(next) } })
                      }
                    />
                    <NumberInput
                      startIcon={EthernetPort}
                      hasNumberSteppers
                      label={tCommon("port")}
                      size="sm"
                      min={1}
                      max={65535}
                      isIntegerOnly
                      value={lb.activeHealthCheck.port ?? null}
                      onChange={(next) =>
                        patch({ activeHealthCheck: { ...lb.activeHealthCheck!, port: next } })
                      }
                    />
                    <TextInput
                      startIcon={Clock}
                      label={t("interval")}
                      size="sm"
                      placeholder="30s"
                      value={lb.activeHealthCheck.interval ?? ""}
                      onChange={(next) =>
                        patch({
                          activeHealthCheck: { ...lb.activeHealthCheck!, interval: str(next) },
                        })
                      }
                    />
                    <TextInput
                      startIcon={Clock}
                      label={t("timeout")}
                      size="sm"
                      placeholder="5s"
                      value={lb.activeHealthCheck.timeout ?? ""}
                      onChange={(next) =>
                        patch({
                          activeHealthCheck: { ...lb.activeHealthCheck!, timeout: str(next) },
                        })
                      }
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("expectedStatus")}
                      size="sm"
                      min={100}
                      max={599}
                      isIntegerOnly
                      value={lb.activeHealthCheck.status ?? null}
                      onChange={(next) =>
                        patch({ activeHealthCheck: { ...lb.activeHealthCheck!, status: next } })
                      }
                    />
                    <TextInput
                      label={t("expectedBody")}
                      size="sm"
                      placeholder={t("ok")}
                      value={lb.activeHealthCheck.body ?? ""}
                      onChange={(next) =>
                        patch({ activeHealthCheck: { ...lb.activeHealthCheck!, body: str(next) } })
                      }
                    />
                  </Grid>
                )}
              </VStack>
            </Card>

            <Card variant="muted">
              <VStack gap={3}>
                <Switch
                  label={t("passiveHealthChecks")}
                  value={Boolean(lb?.passiveHealthCheck?.enabled)}
                  onChange={(on) =>
                    patch({
                      passiveHealthCheck: on
                        ? { ...(lb?.passiveHealthCheck ?? EMPTY_PASSIVE), enabled: true }
                        : null,
                    })
                  }
                />
                {lb?.passiveHealthCheck?.enabled && (
                  <Grid columns={2} gap={3}>
                    <TextInput
                      startIcon={Clock}
                      label={t("failDuration")}
                      size="sm"
                      placeholder="30s"
                      value={lb.passiveHealthCheck.failDuration ?? ""}
                      onChange={(next) =>
                        patch({
                          passiveHealthCheck: {
                            ...lb.passiveHealthCheck!,
                            failDuration: str(next),
                          },
                        })
                      }
                    />
                    <NumberInput
                      hasNumberSteppers
                      label={t("maxFailures")}
                      size="sm"
                      min={0}
                      isIntegerOnly
                      value={lb.passiveHealthCheck.maxFails ?? null}
                      onChange={(next) =>
                        patch({ passiveHealthCheck: { ...lb.passiveHealthCheck!, maxFails: next } })
                      }
                    />
                    <TextInput
                      label={t("unhealthyStatusCodes")}
                      size="sm"
                      placeholder="500, 502, 503"
                      value={lb.passiveHealthCheck.unhealthyStatus?.join(", ") ?? ""}
                      onChange={(next) => {
                        const codes = next
                          .split(",")
                          .map((s) => Number(s.trim()))
                          .filter((n) => Number.isFinite(n) && n >= 100);
                        patch({
                          passiveHealthCheck: {
                            ...lb.passiveHealthCheck!,
                            unhealthyStatus: codes.length > 0 ? codes : null,
                          },
                        });
                      }}
                    />
                    <TextInput
                      startIcon={Clock}
                      label={t("unhealthyLatency")}
                      size="sm"
                      placeholder="5s"
                      value={lb.passiveHealthCheck.unhealthyLatency ?? ""}
                      onChange={(next) =>
                        patch({
                          passiveHealthCheck: {
                            ...lb.passiveHealthCheck!,
                            unhealthyLatency: str(next),
                          },
                        })
                      }
                    />
                  </Grid>
                )}
              </VStack>
            </Card>
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
