"use client";

/**
 * "Why was this blocked": every rule the event matched with its points, the score against the
 * threshold, and what to do about it. Loads the event by key, so a list row stays light.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Ban, Check, ClipboardCopy, ShieldOff } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useTranslations } from "next-intl";
import { getWafEventDetailAction, reviewWafEventAction } from "@/src/app/(dashboard)/waf/actions";
import { withRowIds } from "@/lib/forms/row-id";
import type { AutonomousSystem } from "@/src/lib/geoip/lookup";
import type { WafEventDetail } from "@/src/lib/security/waf-event";
import { BlockSourceDialog, type BlockDraft } from "./BlockSourceDialog";
import { ExclusionDialog, type ExclusionDraft, type HostOption } from "./ExclusionDialog";

function prettyRecord(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export type WafEventNetwork = { userAgent: string | null; asn: AutonomousSystem | null };

export function asnLabel(asn: AutonomousSystem): string {
  return asn.organization ? `AS${asn.number} ${asn.organization}` : `AS${asn.number}`;
}

/** The two rows for a page that has no metadata list of its own. */
function WafEventNetworkMetadata({ userAgent, asn }: WafEventNetwork) {
  const tAnalytics = useTranslations("analytics");
  return (
    <MetadataList columns="multi">
      {asn && (
        <MetadataListItem label={tAnalytics("filterFields.asn")}>
          <Text type="code" size="sm">
            {asnLabel(asn)}
          </Text>
        </MetadataListItem>
      )}
      {userAgent && (
        <MetadataListItem label={tAnalytics("filterFields.ua")}>
          <Text type="code" size="sm">
            {userAgent}
          </Text>
        </MetadataListItem>
      )}
    </MetadataList>
  );
}

export function WafEventInsight({
  eventKey,
  hosts,
  showRawRecord = true,
  onChanged,
  onMetadata,
}: {
  eventKey: string;
  hosts: readonly HostOption[];
  /** Off where the page already shows the record. */
  showRawRecord?: boolean;
  /** After a review, exclusion or block, so the page can refresh its lists. */
  onChanged?: () => void;
  /** When set, the page shows the user agent and ASN in its own metadata list. */
  onMetadata?: (network: WafEventNetwork | null) => void;
}) {
  const t = useTranslations("waf");
  const tCommon = useTranslations("common");
  const [detail, setDetail] = useState<WafEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exclusion, setExclusion] = useState<ExclusionDraft | null>(null);
  const [block, setBlock] = useState<BlockDraft | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const result = await getWafEventDetailAction(eventKey);
    if (result.status === "error") {
      setError(result.message);
      setDetail(null);
    } else {
      setError(null);
      setDetail(result.detail);
      onMetadata?.({ userAgent: result.detail.userAgent, asn: result.detail.asn });
    }
  }, [eventKey, onMetadata]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    // Another event's user agent must not show while this one loads.
    onMetadata?.(null);
    void load();
  }, [load, onMetadata]);

  // Once per load, so a re-render does not re-key the list.
  const rules = useMemo(() => withRowIds(detail?.explanation.rules ?? []), [detail]);

  if (error) return <Banner status="error" title={error} />;
  if (!detail) {
    return (
      <HStack justify="center" vAlign="center">
        <Spinner label={t("eventDetailLoading")} />
      </HStack>
    );
  }

  const { explanation, suggestedExclusion, review, event, relayedBy, userAgent, asn } = detail;
  const reached = explanation.totalScore >= explanation.threshold;

  function saveReview(verdict: "intended" | "false_positive" | null) {
    startTransition(async () => {
      const result = await reviewWafEventAction(eventKey, verdict);
      if (result.status === "error") toast.error(result.message ?? t("reviewFailed"));
      else {
        toast.success(result.message ?? "");
        await load();
        onChanged?.();
      }
    });
  }

  return (
    <VStack gap={4}>
      {!onMetadata && (userAgent || asn) && (
        <WafEventNetworkMetadata userAgent={userAgent} asn={asn} />
      )}
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="label" weight="bold">
            {t("whyBlocked")}
          </Text>
          {review && (
            <Badge
              variant={review.verdict === "intended" ? "success" : "warning"}
              label={
                review.verdict === "intended" ? t("reviewedIntended") : t("reviewedFalsePositive")
              }
            />
          )}
        </HStack>
        <ProgressBar
          label={t("scoreLabel", {
            score: explanation.totalScore,
            threshold: explanation.threshold,
          })}
          value={explanation.totalScore}
          max={Math.max(explanation.totalScore, explanation.threshold)}
          marks={[{ value: explanation.threshold, label: t("thresholdMark") }]}
          variant={reached ? "error" : "warning"}
        />
        <Text type="body" size="sm" color="secondary">
          {explanation.decidingRuleId !== null
            ? t("decidingRule", { id: String(explanation.decidingRuleId) })
            : event.blocked
              ? t("decidingRuleUnknown")
              : t("detectedOnly")}
        </Text>
        {relayedBy && (
          <Text type="body" size="sm" color="secondary">
            {relayedBy.name
              ? t("relayedBy", { name: relayedBy.name })
              : t("relayedByUnpaired", { agentId: relayedBy.agentId })}
          </Text>
        )}
        {!explanation.scoreReported && explanation.rules.length > 0 && (
          <Text type="body" size="sm" color="secondary">
            {t("scoreSummed")}
          </Text>
        )}
      </VStack>

      {explanation.rules.length === 0 ? (
        <Text type="body" size="sm" color="secondary">
          {t("noMatchedRules")}
        </Text>
      ) : (
        <List hasDividers>
          {rules.map((rule) => (
            <ListItem
              // Rules repeat when a chained rule logs each link, so no field of theirs is a key.
              key={rule.rowId}
              label={
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Text type="code" size="sm" weight="semibold">
                    {rule.ruleId ?? "?"}
                  </Text>
                  <Badge label={t("rulePoints", { points: rule.points })} />
                  {rule.paranoiaLevel !== null && (
                    <Badge label={t("ruleParanoia", { level: rule.paranoiaLevel })} />
                  )}
                </HStack>
              }
              description={
                <VStack gap={1}>
                  <Text type="body" size="sm">
                    {rule.message}
                  </Text>
                  {rule.variable && (
                    <Text type="code" size="sm" color="secondary">
                      {t("matchedIn", { variable: rule.variable })}
                    </Text>
                  )}
                  {rule.data && (
                    <Text type="code" size="sm" color="secondary" maxLines={3}>
                      {rule.data}
                    </Text>
                  )}
                </VStack>
              }
            />
          ))}
        </List>
      )}

      <HStack gap={2} wrap="wrap">
        <Button
          size="sm"
          variant="secondary"
          icon={<Check />}
          label={t("workingAsIntended")}
          isDisabled={pending || review?.verdict === "intended"}
          onClick={() => saveReview("intended")}
        />
        {suggestedExclusion && (
          <Button
            size="sm"
            variant="secondary"
            icon={<ShieldOff />}
            label={t("falsePositive")}
            isDisabled={pending}
            onClick={() =>
              setExclusion({
                ruleId: suggestedExclusion.ruleId,
                proxyHostId: suggestedExclusion.proxyHostId,
                path: suggestedExclusion.path ?? "",
                target: suggestedExclusion.target ?? "",
                reason: "",
              })
            }
          />
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={<Ban />}
          label={tCommon("block")}
          isDisabled={pending}
          onClick={() => setBlock({ kind: "ip", value: event.clientIp, reason: "" })}
        />
        <Tooltip content={t("curlPosixNote")}>
          <Button
            size="sm"
            variant="ghost"
            icon={<ClipboardCopy />}
            label={t("copyAsCurl")}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(detail.curl);
                toast.success(t("curlCopied"));
              } catch {
                toast.error(t("curlCopyFailed"));
              }
            }}
          />
        </Tooltip>
        {review && (
          <Button
            size="sm"
            variant="ghost"
            label={t("clearReview")}
            isDisabled={pending}
            onClick={() => saveReview(null)}
          />
        )}
      </HStack>

      {showRawRecord && (
        <Collapsible
          defaultIsOpen={false}
          trigger={
            <Text type="label" size="lg">
              {t("showRawRecord")}
            </Text>
          }
        >
          <CodeBlock
            code={prettyRecord(event.rawData)}
            language="json"
            width="100%"
            isCollapsible
          />
        </Collapsible>
      )}

      <ExclusionDialog
        draft={exclusion}
        hosts={hosts}
        onClose={() => setExclusion(null)}
        onSaved={(message) => {
          setExclusion(null);
          toast.success(message);
          saveReview("false_positive");
        }}
      />
      <BlockSourceDialog
        draft={block}
        onClose={() => setBlock(null)}
        onSaved={(message) => {
          setBlock(null);
          toast.success(message);
          onChanged?.();
        }}
      />
    </VStack>
  );
}
