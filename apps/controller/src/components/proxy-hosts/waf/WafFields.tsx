"use client";

import { useId, useState } from "react";
import { HardDrive, ShieldOff } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Field } from "@astryxdesign/core/Field";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { WafHostConfig } from "@/lib/models/proxy-hosts";
import { bytesToMib, MAX_BODY_LIMIT_MIB, MIN_BODY_LIMIT_MIB } from "@/lib/waf/caddy";
import { WafRuleExclusions } from "./WafRuleExclusions";
import { WafPresetPicker } from "./WafPresetPicker";
import { WafPluginPicker } from "./WafPluginPicker";
import { WafQuickTemplates } from "./WafQuickTemplates";
import { HOST_TEMPLATE_ID_OFFSET } from "@/lib/waf/templates";
import { ModuleGated, useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { useSeclangIssues } from "@/components/ui/seclang-issues";
import { useReportEditorIssues } from "@/components/host-review/editor-issues";
import { useWafPolicy } from "./waf-policy";
import { useTranslations } from "next-intl";

type WafMode = "merge" | "override";
type EngineMode = "Off" | "On" | "DetectionOnly" | "inherit";
type LimitAction = "Reject" | "ProcessPartial" | "inherit";

/** Stored body limits are bytes; the form asks for whole MiB. Null means "inherit". */
function bodyLimitMib(bytes: number | undefined): number | null {
  const mib = bytesToMib(bytes);
  return mib ? Number(mib) : null;
}

type Props = {
  value?: WafHostConfig | null;
  showModeSelector?: boolean;
};

export function WafFields({ value, showModeSelector = true }: Props) {
  const t = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  // Without Coraza compiled in, rules are inert, so the switch says why instead.
  const moduleDisabledReason = useDisabledReason("waf");
  const [enabled, setEnabled] = useState(value?.enabled ?? false);
  const [wafMode, setWafMode] = useState<WafMode>(value?.waf_mode ?? "merge");
  const [engineMode, setEngineMode] = useState<EngineMode>(
    value?.mode === "Off" || value?.mode === "On" || value?.mode === "DetectionOnly"
      ? value.mode
      : "inherit",
  );
  const [loadCrs, setLoadCrs] = useState(value?.load_owasp_crs ?? true);
  const [customDirectives, setCustomDirectives] = useState(value?.custom_directives ?? "");
  const { strictDirectives } = useWafPolicy();
  const directiveIssues = useSeclangIssues(customDirectives, {
    crsLoaded: loadCrs,
    strictDirectives,
  });
  useReportEditorIssues("waf-directives", directiveIssues);
  const [presetIds, setPresetIds] = useState<number[]>(value?.preset_ids ?? []);
  const [pluginIds, setPluginIds] = useState<number[]>(value?.plugin_ids ?? []);
  const [bodyLimitMb, setBodyLimitMb] = useState(bodyLimitMib(value?.request_body_limit));
  const [inMemoryLimitMb, setInMemoryLimitMb] = useState(
    bodyLimitMib(value?.request_body_in_memory_limit),
  );
  const [limitAction, setLimitAction] = useState<LimitAction>(
    value?.request_body_limit_action ?? "inherit",
  );
  const limitActionId = useId();
  const limitActionHelp: Record<LimitAction, string> = {
    inherit: t("overLimitActionHelpInherit"),
    Reject: t("overLimitActionHelpReject"),
    ProcessPartial: t("overLimitActionHelpPartial"),
  };

  return (
    <Card>
      <input type="hidden" name="wafPresent" value="1" />
      <input type="hidden" name="wafEnabled" value={enabled ? "on" : ""} />
      <input type="hidden" name="wafMode" value={wafMode} />
      <input type="hidden" name="wafEngineMode" value={engineMode} />
      <input type="hidden" name="wafLoadOwaspCrs" value={loadCrs ? "on" : ""} />
      <input type="hidden" name="wafCustomDirectives" value={customDirectives} />
      <input type="hidden" name="wafPresetIds" value={JSON.stringify(presetIds)} />
      <input type="hidden" name="wafPluginIds" value={JSON.stringify(pluginIds)} />
      <input type="hidden" name="wafRequestBodyLimitMb" value={bodyLimitMb ?? ""} />
      <input type="hidden" name="wafRequestBodyInMemoryLimitMb" value={inMemoryLimitMb ?? ""} />
      <input
        type="hidden"
        name="wafRequestBodyLimitAction"
        value={limitAction === "inherit" ? "" : limitAction}
      />

      <VStack gap={4}>
        <HStack justify="between" vAlign="start" gap={2}>
          <HStack gap={3} vAlign="start">
            <Icon icon={ShieldOff} size="md" color="error" />
            <VStack gap={1}>
              <Text type="body" size="sm" weight="bold">
                {t("webApplicationFirewall")}
              </Text>
              <Text type="body" size="sm" color="secondary">
                {t("wafDescription")}
              </Text>
            </VStack>
          </HStack>
          {/* Wrapped: disabled controls emit no pointer events for a tooltip. */}
          <ModuleGated feature="waf">
            <Switch
              label={t("enableWebApplicationFirewall")}
              isLabelHidden
              value={enabled}
              onChange={setEnabled}
              isDisabled={Boolean(moduleDisabledReason)}
            />
          </ModuleGated>
        </HStack>

        {moduleDisabledReason && <Text type="supporting">{moduleDisabledReason}</Text>}

        {/* Unmounted when off, so nothing below is focusable or submitted. Not gated on
            moduleDisabledReason: a missing wafExcludedRuleIds input reads as "no exclusions"
            and would wipe the list on save. */}
        {enabled && (
          <VStack gap={4}>
            {showModeSelector && (
              <>
                <SegmentedControl
                  label={t("globalRuleHandling")}
                  value={wafMode}
                  onChange={(next) => setWafMode(next as WafMode)}
                >
                  <SegmentedControlItem value="merge" label={t("mergeWithGlobal")} />
                  <SegmentedControlItem value="override" label={t("overrideGlobal")} />
                </SegmentedControl>
                <Divider />
              </>
            )}
            {!showModeSelector && <Divider />}

            <SegmentedControl
              label={t("engineMode")}
              value={engineMode}
              onChange={(next) => setEngineMode(next as EngineMode)}
            >
              <SegmentedControlItem value="inherit" label={t("globalDefault")} />
              <SegmentedControlItem value="Off" label={t("off")} />
              <SegmentedControlItem value="DetectionOnly" label={t("detectionOnly")} />
              <SegmentedControlItem value="On" label={t("on")} />
            </SegmentedControl>

            <Divider />

            <Switch
              label={t("owaspCrsLabel")}
              description={t("owaspCrsHelp")}
              value={loadCrs}
              onChange={setLoadCrs}
            />

            <Divider />

            <VStack gap={2}>
              <Text type="body" size="sm" weight="bold">
                {t("requestBodyLimits")}
              </Text>
              <Text type="supporting">{t("wafBodyLimitsDescription")}</Text>
              <HStack gap={3} vAlign="start" wrap="wrap">
                <NumberInput
                  startIcon={HardDrive}
                  hasNumberSteppers
                  units={tCommon("unitMib")}
                  label={t("maxBodySizeMib", { max: MAX_BODY_LIMIT_MIB })}
                  value={bodyLimitMb}
                  onChange={setBodyLimitMb}
                  min={MIN_BODY_LIMIT_MIB}
                  max={MAX_BODY_LIMIT_MIB}
                  step={1}
                  isIntegerOnly
                  hasClear
                  placeholder={t("inherit")}
                />
                <NumberInput
                  startIcon={HardDrive}
                  hasNumberSteppers
                  units={tCommon("unitMib")}
                  label={t("bufferedInMemoryMib")}
                  value={inMemoryLimitMb}
                  onChange={setInMemoryLimitMb}
                  min={MIN_BODY_LIMIT_MIB}
                  max={MAX_BODY_LIMIT_MIB}
                  step={1}
                  isIntegerOnly
                  hasClear
                  placeholder={t("inherit")}
                />
              </HStack>
              {/* SegmentedControl's own label is only an aria-label; Field draws the visible one. */}
              <Field
                label={t("overLimitAction")}
                inputID={limitActionId}
                isGroupLabel
                description={limitActionHelp[limitAction]}
              >
                {/* The HStack keeps Field's column from stretching the control across the dialog. */}
                <HStack>
                  <SegmentedControl
                    label={t("overLimitAction")}
                    value={limitAction}
                    onChange={(next) => setLimitAction(next as LimitAction)}
                  >
                    <SegmentedControlItem value="inherit" label={t("inherit")} />
                    <SegmentedControlItem value="Reject" label={t("reject")} />
                    <SegmentedControlItem value="ProcessPartial" label={t("partial")} />
                  </SegmentedControl>
                </HStack>
              </Field>
            </VStack>

            <Divider />

            <WafRuleExclusions value={value?.excluded_rule_ids} />

            <WafPresetPicker
              value={presetIds}
              onChange={setPresetIds}
              description={
                wafMode === "override" ? t("wafPresetsHelpOverride") : t("wafPresetsHelpMerge")
              }
            />

            <WafPluginPicker
              value={pluginIds}
              onChange={setPluginIds}
              crsLoaded={loadCrs}
              description={
                wafMode === "override" ? t("wafPluginsHelpOverride") : t("wafPluginsHelpMerge")
              }
            />

            <CodeEditor
              label={t("customSeclangDirectives")}
              language="seclang"
              placeholder={`SecRule REQUEST_URI "@contains /secret" "id:9001,deny,status:403,log,msg:'Blocked path'"`}
              value={customDirectives}
              issues={directiveIssues}
              onChange={setCustomDirectives}
              height="sm"
              description={t("customWafDirectivesHelp")}
            />

            <WafQuickTemplates idOffset={HOST_TEMPLATE_ID_OFFSET} onInsert={setCustomDirectives} />
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
