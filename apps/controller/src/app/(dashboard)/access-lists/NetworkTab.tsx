"use client";

import { useEffect, useState } from "react";
import { isSubmittedForApproval } from "@/lib/approvals/submitted";
import { ArrowDown, ArrowUp, Network, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { AccessList, AccessListIpRule } from "@/lib/models/access-lists";
import {
  type AccessRuleKind,
  DEFAULT_DENY_STATUS,
  DENY_STATUS_MAX,
  DENY_STATUS_MIN,
  MAX_DENY_BODY_LENGTH,
} from "@/lib/access-lists/limits";
import { BLOCK_EXPIRY_PRESETS, CONTINENT_CODES } from "@/lib/blocked-sources/types";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { FlagIcon, isKnownCountry } from "@/components/ui/CountryFlag";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { Switch } from "@/components/ui/FormBooleanControls";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { unwrap } from "@/src/lib/errors/action-result";
import { setAccessListIpRulesAction, updateAccessListAction } from "./actions";

type Rule = {
  action: "allow" | "deny";
  kind: AccessRuleKind;
  /** An address, range or hostname; a country or continent code; or an ASN. */
  target: string;
  note: string;
  expiresAt: string | null;
};

function kindOf(rule: AccessListIpRule): AccessRuleKind {
  if (rule.country) return "country";
  if (rule.continent) return "continent";
  if (rule.asn) return "asn";
  return "address";
}

function targetOf(rule: AccessListIpRule): string {
  return rule.cidr ?? rule.hostname ?? rule.country ?? rule.continent ?? String(rule.asn ?? "");
}

function toRules(list: AccessList): WithRowId<Rule>[] {
  return withRowIds(
    list.ipRules.map((rule) => ({
      action: rule.action,
      kind: kindOf(rule),
      target: targetOf(rule),
      note: rule.note ?? "",
      expiresAt: rule.expiresAt ?? null,
    })),
  );
}

const fingerprint = (rules: Rule[]) =>
  JSON.stringify(
    rules.map(({ action, kind, target, note, expiresAt }) => [
      action,
      kind,
      target.trim(),
      note.trim(),
      expiresAt,
    ]),
  );

type DenyMode = "default" | "status" | "redirect";

/**
 * The list's rules, checked top to bottom: the first one matching the client decides. Saved as a
 * whole, since the order is the meaning. Below them, what a refused request gets.
 */
export function NetworkTab({
  list,
  onListUpdated,
}: {
  list: AccessList;
  onListUpdated: (list: AccessList) => void;
}) {
  const t = useTranslations("accessLists");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const geoUnavailable = useDisabledReason("geoblock");
  const [rules, setRules] = useState(() => toRules(list));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different list resets the editor
  useEffect(() => {
    setRules(toRules(list));
    setError(null);
  }, [list.id, list.updatedAt]);

  const actionOptions = [
    { value: "allow", label: t("ipAllow") },
    { value: "deny", label: t("ipDeny") },
  ];
  const kindOptions = [
    { value: "address", label: t("ruleKinds.address") },
    { value: "country", label: t("ruleKinds.country") },
    { value: "continent", label: t("ruleKinds.continent") },
    { value: "asn", label: t("ruleKinds.asn") },
  ];
  const continentOptions = CONTINENT_CODES.map((code) => ({
    value: code,
    label: t(`continents.${code.toLowerCase() as Lowercase<typeof code>}`),
  }));

  const patch = (rowId: string, change: Partial<Rule>) =>
    setRules((current) =>
      current.map((rule) => (rule.rowId === rowId ? { ...rule, ...change } : rule)),
    );

  const move = (index: number, by: -1 | 1) =>
    setRules((current) => {
      const next = [...current];
      const [rule] = next.splice(index, 1);
      next.splice(index + by, 0, rule);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = unwrap(
        await setAccessListIpRulesAction(
          list.id,
          rules
            .filter((rule) => rule.target.trim())
            .map(({ action, kind, target, note, expiresAt }) => ({
              action,
              kind,
              target: target.trim(),
              note: note.trim() || null,
              expiresAt,
            })),
        ),
      );
      if (isSubmittedForApproval(updated)) toast.success(updated.message);
      else {
        onListUpdated(updated);
        toast.success(t("saved"));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ipRulesSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const saveSetting = async (input: Parameters<typeof updateAccessListAction>[1]) => {
    try {
      const updated = unwrap(await updateAccessListAction(list.id, input));
      if (isSubmittedForApproval(updated)) toast.success(updated.message);
      else {
        onListUpdated(updated);
        toast.success(t("saved"));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("ipRulesSaveFailed"));
    }
  };

  const dirty = fingerprint(toRules(list)) !== fingerprint(rules);

  // Keyed by what was saved, so a status never shows beside a name edited since.
  const statusByTarget = new Map(
    list.ipRules.flatMap((rule) =>
      rule.hostname && rule.resolved ? [[`${rule.action} ${rule.hostname}`, rule.resolved]] : [],
    ),
  );
  const failingOpen = list.ipRules.some(
    (rule) => rule.action === "deny" && rule.resolved && rule.resolved.ranges.length === 0,
  );
  const hasGeoRules = list.ipRules.some((rule) => rule.country || rule.continent || rule.asn);

  const hostnameStatus = (rule: Rule) => {
    if (rule.kind !== "address") return null;
    const status = statusByTarget.get(`${rule.action} ${rule.target.trim()}`);
    if (!status) return null;
    if (status.ranges.length > 0) {
      return (
        <Text type="supporting" size="sm">
          {status.lastError
            ? t("ipHostnameStale", { ranges: status.ranges.join(", "), error: status.lastError })
            : t("ipHostnameResolved", { ranges: status.ranges.join(", ") })}
        </Text>
      );
    }
    return (
      <Text type="supporting" size="sm">
        {status.lastError
          ? t("ipHostnameFailed", { action: rule.action, error: status.lastError })
          : t("ipHostnamePending", { action: rule.action })}
      </Text>
    );
  };

  const expiryOptions = (rule: Rule) => [
    ...(rule.expiresAt
      ? [
          {
            value: "keep",
            label: t("ruleExpiresAt", {
              at: format.dateTime(new Date(rule.expiresAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            }),
          },
        ]
      : []),
    ...BLOCK_EXPIRY_PRESETS.map((preset) => ({
      value: preset.id,
      label: t(`ruleExpiry.${preset.labelKey}`),
    })),
  ];

  const setExpiry = (rule: WithRowId<Rule>, value: string) => {
    if (value === "keep") return;
    const seconds = BLOCK_EXPIRY_PRESETS.find((preset) => preset.id === value)?.seconds ?? null;
    patch(rule.rowId, {
      expiresAt: seconds === null ? null : new Date(Date.now() + seconds * 1000).toISOString(),
    });
  };

  const targetInput = (rule: WithRowId<Rule>, index: number) => {
    if (rule.kind === "continent") {
      return (
        <Selector
          label={t("ruleTarget")}
          isLabelHidden={index > 0}
          size="sm"
          width={200}
          options={continentOptions}
          value={rule.target || undefined}
          placeholder={t("ruleContinentPlaceholder")}
          onChange={(next) => patch(rule.rowId, { target: String(next ?? "") })}
        />
      );
    }
    return (
      <TextInput
        startIcon={
          rule.kind === "country" && isKnownCountry(rule.target.trim()) ? (
            <FlagIcon code={rule.target.trim()} />
          ) : (
            Network
          )
        }
        {...NO_SPELLCHECK}
        label={rule.kind === "address" ? t("ipCidr") : t("ruleTarget")}
        isLabelHidden={index > 0}
        size="sm"
        placeholder={t(`rulePlaceholders.${rule.kind}`)}
        value={rule.target}
        onChange={(next) => patch(rule.rowId, { target: next })}
      />
    );
  };

  return (
    <VStack gap={4} maxWidth={880}>
      <Text type="body" size="sm" color="secondary">
        {t("ipRulesHelp")}
      </Text>
      <Text type="body" size="sm" color="secondary">
        {t("geoRulesHelp")}
      </Text>
      {error && <Banner status="error" title={t("ipRulesSaveFailed")} description={error} />}
      {hasGeoRules && geoUnavailable && (
        <Banner
          status="warning"
          title={t("geoRulesSkippedTitle")}
          description={t("geoRulesSkippedHelp", { reason: geoUnavailable })}
        />
      )}
      {failingOpen && (
        <Banner
          status="warning"
          title={t("ipHostnameFailOpenTitle")}
          description={t("ipHostnameFailOpenHelp")}
        />
      )}

      {rules.length > 0 && (
        <VStack gap={2}>
          {rules.map((rule, index) => (
            <VStack key={rule.rowId} gap={1}>
              <HStack gap={2} vAlign="end" wrap="wrap">
                <Selector
                  label={t("ipAction")}
                  isLabelHidden={index > 0}
                  size="sm"
                  width={100}
                  options={actionOptions}
                  value={rule.action}
                  onChange={(next) => patch(rule.rowId, { action: next as Rule["action"] })}
                />
                <Selector
                  label={t("ruleKind")}
                  isLabelHidden={index > 0}
                  size="sm"
                  width={150}
                  options={kindOptions}
                  value={rule.kind}
                  onChange={(next) =>
                    patch(rule.rowId, { kind: next as AccessRuleKind, target: "" })
                  }
                />
                {targetInput(rule, index)}
                <TextInput
                  label={t("ipNote")}
                  isLabelHidden={index > 0}
                  size="sm"
                  value={rule.note}
                  onChange={(next) => patch(rule.rowId, { note: next })}
                />
                <Selector
                  label={t("ruleExpiryLabel")}
                  isLabelHidden={index > 0}
                  size="sm"
                  width={190}
                  options={expiryOptions(rule)}
                  value={rule.expiresAt ? "keep" : "never"}
                  onChange={(next) => setExpiry(rule, String(next ?? "never"))}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={t("ipMoveUp", { index: index + 1 })}
                  icon={<ArrowUp />}
                  isDisabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={t("ipMoveDown", { index: index + 1 })}
                  icon={<ArrowDown />}
                  isDisabled={index === rules.length - 1}
                  onClick={() => move(index, 1)}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={t("ipRemove", { index: index + 1 })}
                  icon={<Trash2 />}
                  onClick={() =>
                    setRules((current) => current.filter((r) => r.rowId !== rule.rowId))
                  }
                />
              </HStack>
              {hostnameStatus(rule)}
            </VStack>
          ))}
        </VStack>
      )}

      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus />}
          label={tCommon("add")}
          onClick={() =>
            setRules((current) => [
              ...current,
              withRowId({
                action: "allow",
                kind: "address",
                target: "",
                note: "",
                expiresAt: null,
              }),
            ])
          }
        />
        <Button
          size="sm"
          label={tCommon("save")}
          onClick={save}
          isLoading={saving}
          isDisabled={!dirty || saving}
        />
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            label={tCommon("discard")}
            onClick={() => setRules(toRules(list))}
          />
        )}
      </HStack>

      <Selector
        label={t("ipDefault")}
        description={t("ipDefaultHelp")}
        size="sm"
        width={320}
        options={[
          { value: "deny", label: t("ipDeny") },
          { value: "allow", label: t("ipAllow") },
        ]}
        value={list.ipDefault}
        onChange={(next) => saveSetting({ ipDefault: next as string })}
      />

      <Switch
        label={t("failClosed")}
        description={t("failClosedHelp")}
        labelPosition="start"
        labelSpacing="spread"
        value={list.failClosed}
        onChange={(next) => saveSetting({ failClosed: next })}
      />

      <Divider />
      <DenyResponseEditor list={list} onSave={(denyResponse) => saveSetting({ denyResponse })} />
    </VStack>
  );
}

function DenyResponseEditor({
  list,
  onSave,
}: {
  list: AccessList;
  onSave: (deny: { status?: number; body?: string; redirectUrl?: string } | null) => Promise<void>;
}) {
  const t = useTranslations("accessLists");
  const saved = list.denyResponse;
  const initialMode: DenyMode = saved?.redirectUrl ? "redirect" : saved ? "status" : "default";
  const [mode, setMode] = useState<DenyMode>(initialMode);
  const [status, setStatus] = useState<number | null>(saved?.status ?? DEFAULT_DENY_STATUS);
  const [body, setBody] = useState(saved?.body ?? "");
  const [redirectUrl, setRedirectUrl] = useState(saved?.redirectUrl ?? "");
  const [saving, setSaving] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different list resets the editor
  useEffect(() => {
    setMode(initialMode);
    setStatus(saved?.status ?? DEFAULT_DENY_STATUS);
    setBody(saved?.body ?? "");
    setRedirectUrl(saved?.redirectUrl ?? "");
  }, [list.id, list.updatedAt]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(
        mode === "default"
          ? null
          : mode === "redirect"
            ? { redirectUrl: redirectUrl.trim() }
            : { status: status ?? DEFAULT_DENY_STATUS, body },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <VStack gap={3}>
      <Heading level={4}>{t("denyResponse")}</Heading>
      <Text type="body" size="sm" color="secondary">
        {t("denyResponseHelp")}
      </Text>
      <Selector
        label={t("denyMode")}
        size="sm"
        width={320}
        options={[
          { value: "default", label: t("denyModes.default") },
          { value: "status", label: t("denyModes.status") },
          { value: "redirect", label: t("denyModes.redirect") },
        ]}
        value={mode}
        onChange={(next) => setMode((next as DenyMode) ?? "default")}
      />
      {mode === "status" && (
        <>
          <NumberInput
            hasNumberSteppers
            label={t("denyStatus")}
            size="sm"
            width={160}
            min={DENY_STATUS_MIN}
            max={DENY_STATUS_MAX}
            isIntegerOnly
            value={status}
            onChange={setStatus}
          />
          <TextArea
            label={t("denyBody")}
            description={t("denyBodyHelp", { max: MAX_DENY_BODY_LENGTH })}
            isOptional
            size="sm"
            rows={4}
            value={body}
            onChange={setBody}
          />
        </>
      )}
      {mode === "redirect" && (
        <TextInput
          {...NO_SPELLCHECK}
          label={t("denyRedirect")}
          description={t("denyRedirectHelp")}
          size="sm"
          placeholder="https://example.com/denied"
          value={redirectUrl}
          onChange={setRedirectUrl}
        />
      )}
      <HStack>
        <Button size="sm" label={t("saveDenyResponse")} onClick={save} isLoading={saving} />
      </HStack>
    </VStack>
  );
}
