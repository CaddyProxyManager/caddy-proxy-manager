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
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useTranslations } from "next-intl";
import { getWafEventDetailAction, reviewWafEventAction } from "@/src/app/(dashboard)/waf/actions";
import { withRowIds } from "@/lib/forms/row-id";
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

export function WafEventInsight({
  eventKey,
  hosts,
  showRawRecord = true,
  onChanged,
}: {
  eventKey: string;
  hosts: readonly HostOption[];
  /** Off where the page already shows the record. */
  showRawRecord?: boolean;
  /** After a review, exclusion or block, so the page can refresh its lists. */
  onChanged?: () => void;
}) {
  const t = useTranslations("waf");
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
    }
  }, [eventKey]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void load();
  }, [load]);

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

  const { explanation, suggestedExclusion, review, event, relayedBy } = detail;
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
        <Text type="body" size="xsm" color="secondary">
          {explanation.decidingRuleId !== null
            ? t("decidingRule", { id: String(explanation.decidingRuleId) })
            : event.blocked
              ? t("decidingRuleUnknown")
              : t("detectedOnly")}
        </Text>
        {relayedBy && (
          <Text type="body" size="xsm" color="secondary">
            {relayedBy.name
              ? t("relayedBy", { name: relayedBy.name })
              : t("relayedByUnpaired", { agentId: relayedBy.agentId })}
          </Text>
        )}
        {!explanation.scoreReported && explanation.rules.length > 0 && (
          <Text type="body" size="xsm" color="secondary">
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
                    <Text type="code" size="xsm" color="secondary">
                      {t("matchedIn", { variable: rule.variable })}
                    </Text>
                  )}
                  {rule.data && (
                    <Text type="code" size="xsm" color="secondary" maxLines={3}>
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
          label={t("blockSource")}
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
