"use client";

/** Save only records; Rebuild restarts the proxy, hence two separately-confirmed buttons. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Hammer, Package, PackageCheck, Plus, Trash2 } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { FieldStatus } from "@astryxdesign/core/FieldStatus";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Selector } from "@astryxdesign/core/Selector";
import { Table, type TableColumn, pixel, proportional } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { Switch } from "@/components/ui/FormBooleanControls";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { nativeAttrs } from "@/components/ui/native-input-attrs";
import { useTranslations } from "next-intl";
import {
  CADDY_MODULES,
  type CaddyCustomModule,
  type CaddyModuleCategory,
  type CaddyModuleDefinition,
  CUSTOM_MODULE_NAME_MAX,
  customModuleProblem,
  customModuleSpec,
  validateCustomModule,
} from "@/src/lib/caddy/image-build/modules";
import {
  caddyModuleDescription,
  caddyModuleName,
} from "@/src/lib/caddy/image-build/module-messages";
import { agentStatusMessage, type AgentStatusWords } from "@/src/lib/agent/status-message";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import { caddyImageBuildCommand, caddyImageTag } from "@/src/lib/caddy/image-build/image";

type BuildStatus = AgentStatusWords & {
  state: "idle" | "pending" | "building" | "applied" | "failed";
  appliedAt?: string;
  error?: string;
};

type BuildDiff = {
  appliedSpecs: string[];
  desiredSpecs: string[];
  added: string[];
  removed: string[];
  needsRebuild: boolean;
};

/** An agent that loads an operator-built image; see `caddyBuildAgents`. */
type ExternalAgent = { name: string; image: string | null; puid: string; pgid: string };

type BuildResponse = {
  diff: BuildDiff;
  status: BuildStatus;
  /** Targeted agents that build their own image. */
  builders: number;
  external: ExternalAgent[];
};

type CustomModuleRow = CaddyCustomModule & { uid: string };

let rowIdCounter = 0;
const nextRowId = () => `custom-${++rowIdCounter}`;

const CATEGORY_LABEL_KEYS: Record<
  CaddyModuleCategory,
  "categoryProxy" | "categoryCache" | "categorySecurity" | "categoryDns"
> = {
  proxy: "categoryProxy",
  cache: "categoryCache",
  security: "categorySecurity",
  dns: "categoryDns",
};

const CATEGORY_ORDER: CaddyModuleCategory[] = ["proxy", "cache", "security", "dns"];

function groupModules(): [CaddyModuleCategory, CaddyModuleDefinition[]][] {
  return CATEGORY_ORDER.map((category) => [
    category,
    CADDY_MODULES.filter((m) => m.category === category),
  ]);
}

/** Zero is never an `agents.id`, so it cannot collide. */
const FLEET = 0;

const CACHE_HANDLER_MODULE_ID = "cache-handler";

function resolveModuleMap(overrides: Record<string, boolean>): Record<string, boolean> {
  const resolved: Record<string, boolean> = {};
  for (const module of CADDY_MODULES) {
    // Missing means its default: on, so a module added since the last save is on, unless opt-in.
    resolved[module.id] = overrides[module.id] ?? module.defaultEnabled !== false;
  }
  return resolved;
}

export function CaddyBuildFields({
  initialModules,
  initialCustomModules,
  agents = [],
  agentSelections = {},
}: {
  initialModules: Record<string, boolean>;
  initialCustomModules: CaddyCustomModule[];
  agents?: { id: number; name: string; connected: boolean }[];
  /** Keyed by row id; absent or null follows the fleet default. */
  agentSelections?: Record<
    number,
    { modules: Record<string, boolean>; customModules: CaddyCustomModule[] } | null
  >;
}) {
  const t = useTranslations("caddyModules");
  const tCommon = useTranslations("common");
  // Custom module problems are domain error codes, which live at the catalog root.
  const tRoot = useTranslations();
  const [target, setTarget] = useState<number>(FLEET);
  // Saving with this on clears the agent's row rather than freezing a copy of today's fleet.
  const [follows, setFollows] = useState(false);
  const [modules, setModules] = useState<Record<string, boolean>>(() =>
    resolveModuleMap(initialModules),
  );
  // A client-only key: by index, React recycles inputs into the wrong row after a delete.
  const [customModules, setCustomModules] = useState<CustomModuleRow[]>(() =>
    initialCustomModules.map((entry) => ({ ...entry, uid: nextRowId() })),
  );

  // An agent with no selection starts from the fleet's, which is what it actually runs.
  const selectTarget = (next: number) => {
    setTarget(next);
    const own = next === FLEET ? null : (agentSelections[next] ?? null);
    setFollows(next !== FLEET && own === null);
    setModules(resolveModuleMap(own?.modules ?? initialModules));
    setCustomModules(
      (own?.customModules ?? initialCustomModules).map((entry) => ({
        ...entry,
        uid: nextRowId(),
      })),
    );
  };
  const [build, setBuild] = useState<BuildResponse | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  // The trigger request's own errors, which never reach the status file.
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(
        target === FLEET ? "/api/caddy-build" : `/api/caddy-build?agent=${target}`,
      );
      if (res.ok) setBuild(await res.json());
    } catch {
      // The next tick retries.
    }
  }, [target]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Slower than the L4 banner's poll: a build takes minutes.
  const inFlight = build?.status.state === "pending" || build?.status.state === "building";
  useEffect(() => {
    if (!inFlight) return;
    const interval = setInterval(() => void fetchStatus(), 5000);
    return () => clearInterval(interval);
  }, [inFlight, fetchStatus]);

  const enabledCount = useMemo(
    () =>
      Object.values(modules).filter(Boolean).length + customModules.filter((c) => c.enabled).length,
    [modules, customModules],
  );

  // The same list the server builds from, so this is what xcaddy will get.
  const previewSpecs = useMemo(() => {
    const builtIn = CADDY_MODULES.filter((m) => modules[m.id]).map((m) => m.modulePath);
    const custom = customModules
      .filter((c) => c.enabled && validateCustomModule(c) === null)
      .map(customModuleSpec);
    return Array.from(new Set([...builtIn, ...custom])).sort();
  }, [modules, customModules]);

  // The first external agent's image and ids; a fleet of them usually shares one build.
  const externalAgent = build?.external[0] ?? null;
  const externalOnly = Boolean(externalAgent) && build?.builders === 0;
  const buildCommand = useMemo(
    () =>
      caddyImageBuildCommand({
        modules: previewSpecs,
        image: externalAgent?.image ?? null,
        puid: externalAgent?.puid ?? "",
        pgid: externalAgent?.pgid ?? "",
      }),
    [previewSpecs, externalAgent],
  );

  // External mode's rebuild is loading the image the operator built; same errors, same poll.
  const handleRebuild = async () => {
    setRebuilding(true);
    setRebuildError(null);
    const path = externalOnly ? "/api/caddy-build/image" : "/api/caddy-build";
    try {
      const res = await fetch(target === FLEET ? path : `${path}?agent=${target}`, {
        method: "POST",
      });
      if (!res.ok) {
        // These abort before the agent writes a status, so the poll would never see them.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setRebuildError(body?.error ?? t("rebuildCouldNotStartHttp", { status: res.status }));
        return;
      }
      await fetchStatus();
    } catch (error) {
      setRebuildError(error instanceof Error ? error.message : t("rebuildCouldNotStart"));
    } finally {
      setRebuilding(false);
    }
  };

  const addCustomModule = () =>
    setCustomModules((prev) => [
      ...prev,
      { name: "", modulePath: "", version: "", enabled: true, uid: nextRowId() },
    ]);

  const updateCustomModule = (uid: string, patch: Partial<CaddyCustomModule>) =>
    setCustomModules((prev) => prev.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));

  const removeCustomModule = (uid: string) =>
    setCustomModules((prev) => prev.filter((c) => c.uid !== uid));

  // Inputs keep their labels for screen readers, hidden: the column headings say it on screen.
  const customModuleColumns: TableColumn<CustomModuleRow>[] = [
    {
      key: "enabled",
      header: <VisuallyHidden>{t("customModuleInclude")}</VisuallyHidden>,
      width: pixel(56),
      renderCell: (entry) => (
        <Switch
          label={t("customModuleIncludeNamed", {
            name: entry.name?.trim() || entry.modulePath.trim() || t("customModulesTitle"),
          })}
          isLabelHidden
          value={entry.enabled}
          onChange={(next) => updateCustomModule(entry.uid, { enabled: next })}
        />
      ),
    },
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (entry) => (
        <TextInput
          label={tCommon("name")}
          isLabelHidden
          value={entry.name ?? ""}
          onChange={(next) => updateCustomModule(entry.uid, { name: next })}
          placeholder={t("customModuleNamePlaceholder")}
          {...nativeAttrs({ maxLength: CUSTOM_MODULE_NAME_MAX })}
        />
      ),
    },
    {
      key: "modulePath",
      header: t("modulePath"),
      width: proportional(2),
      renderCell: (entry) => {
        const problem = entry.modulePath.trim() ? customModuleProblem(entry) : null;
        const error = problem ? extractErrorMessage(tRoot, problem, problem.message) : null;
        return (
          <TextInput
            startIcon={Package}
            label={t("modulePath")}
            isLabelHidden
            value={entry.modulePath}
            onChange={(next) => updateCustomModule(entry.uid, { modulePath: next })}
            placeholder={t("modulePathPlaceholder")}
            status={error ? { type: "error", message: error } : undefined}
          />
        );
      },
    },
    {
      key: "version",
      header: tCommon("version"),
      width: pixel(112),
      renderCell: (entry) => (
        <TextInput
          label={tCommon("version")}
          isLabelHidden
          value={entry.version ?? ""}
          onChange={(next) => updateCustomModule(entry.uid, { version: next })}
          placeholder="latest"
        />
      ),
    },
    {
      key: "uid",
      header: <VisuallyHidden>{tCommon("remove")}</VisuallyHidden>,
      width: pixel(48),
      renderCell: (entry) => (
        <Button
          variant="ghost"
          icon={<Trash2 />}
          label={tCommon("remove")}
          isIconOnly
          onClick={() => removeCustomModule(entry.uid)}
        />
      ),
    },
  ];

  return (
    <VStack gap={5}>
      <input type="hidden" name="agentRowId" value={String(target)} />
      {target !== FLEET && follows && <input type="hidden" name="followFleetDefault" value="1" />}

      {agents.length > 0 && (
        <Card padding={4}>
          <VStack gap={3}>
            <Selector
              label={t("buildTarget")}
              description={t("buildTargetHelp")}
              options={[
                { value: String(FLEET), label: t("fleetDefault") },
                ...agents.map((agent) => ({
                  value: String(agent.id),
                  label: agent.name,
                })),
              ]}
              value={String(target)}
              onChange={(next) => selectTarget(Number(next))}
            />
            {target !== FLEET && (
              <Switch
                label={t("followFleetDefault")}
                description={t("followFleetDefaultHelp")}
                labelPosition="start"
                labelSpacing="spread"
                value={follows}
                onChange={setFollows}
              />
            )}
          </VStack>
        </Card>
      )}

      {rebuildError && (
        <Banner status="error" title={t("rebuildFailedToStart")} description={rebuildError} />
      )}

      <RebuildBanner
        build={build}
        rebuilding={rebuilding}
        onRebuild={handleRebuild}
        inFlight={Boolean(inFlight)}
        external={externalOnly}
      />

      {build && build.external.length > 0 && build.builders > 0 && (
        <Banner
          status="info"
          title={t("externalAgentsTitle")}
          description={t("externalAgentsNote", {
            names: build.external.map((agent) => agent.name).join(", "),
          })}
        />
      )}

      <Banner
        status="info"
        title={t("rebuildRequiredTitle")}
        description={t("rebuildRequiredDescription")}
      />

      {/* One card, a section per category, so the list reads as one set of choices. */}
      <Card padding={4}>
        <VStack gap={4}>
          {groupModules().map(([category, group], index) => (
            <VStack key={category} gap={3}>
              {index > 0 && <Divider />}
              <HStack justify="between" align="center">
                <Heading level={3}>{t(CATEGORY_LABEL_KEYS[category])}</Heading>
                <Badge label={`${group.filter((m) => modules[m.id]).length}/${group.length}`} />
              </HStack>
              {group.map((module) => (
                <ModuleToggle
                  key={module.id}
                  module={module}
                  posted={modules[module.id] === true}
                  value={modules[module.id] ?? module.defaultEnabled !== false}
                  onChange={(next) => setModules((prev) => ({ ...prev, [module.id]: next }))}
                  // A storage registers itself with Souin, which only HTTP Cache builds in; without
                  // it the storage compiles but nothing loads it.
                  warning={
                    module.cacheStorage &&
                    (modules[module.id] ?? module.defaultEnabled !== false) &&
                    !modules[CACHE_HANDLER_MODULE_ID]
                      ? t("cacheStorageNeedsHandler")
                      : undefined
                  }
                />
              ))}
            </VStack>
          ))}

          <VStack gap={3}>
            <Divider />
            <HStack justify="between" align="center">
              <Heading level={3}>{t("customModulesTitle")}</Heading>
              <Badge
                label={`${customModules.filter((c) => c.enabled).length}/${customModules.length}`}
              />
            </HStack>
            <Text type="body" size="xsm" color="secondary">
              {t("customModuleHelp")} {t("moduleVersionHelp")}
            </Text>

            {customModules.length === 0 ? (
              <Text type="body" size="sm" color="secondary">
                {t("noCustomModules")}
              </Text>
            ) : (
              // The switch first, as in the lists above. Scrolls sideways on a phone.
              <Table
                data={customModules}
                idKey="uid"
                columns={customModuleColumns}
                density="compact"
                dividers="none"
                verticalAlign="top"
              />
            )}

            <HStack justify="start">
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus />}
                label={tCommon("add")}
                onClick={addCustomModule}
              />
            </HStack>
          </VStack>
        </VStack>
      </Card>

      <CodeEditor
        label={t("buildCommandPreview")}
        language="bash"
        value={buildCommand}
        isReadOnly
        isFooterHidden
        isCopyable
        height="lg"
        description={
          externalAgent
            ? t("buildCommandHelpExternal", {
                count: enabledCount,
                image: caddyImageTag(externalAgent.image),
              })
            : t("buildCommandHelpAgent", { count: enabledCount })
        }
      />

      {/* The custom rows are React state; this carries them to the server action. One input for
          many fields, so the page's unsaved marking leaves labels to the rows' own controls. */}
      <input
        type="hidden"
        data-unsaved-label="none"
        name="customModulesJson"
        value={JSON.stringify(
          customModules.map(({ uid: _uid, ...entry }) => entry as CaddyCustomModule),
        )}
      />
    </VStack>
  );
}

function ModuleToggle({
  module,
  posted,
  value,
  onChange,
  warning,
}: {
  module: CaddyModuleDefinition;
  /** What the form posts, which can differ from `value` before the selection is resolved. */
  posted: boolean;
  value: boolean;
  onChange: (next: boolean) => void;
  /** On, but unusable as the selection stands. */
  warning?: string;
}) {
  const t = useTranslations();
  return (
    <VStack gap={1}>
      {/* Beside its own switch: the page marks a hidden input's change on its nearest labels, and
          all of them together would mark every module's. */}
      <input type="hidden" name={`module:${module.id}`} value={posted ? "on" : ""} />
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Switch label={caddyModuleName(t, module)} value={value} onChange={onChange} />
        {module.docsUrl && (
          <Text type="body" size="xsm">
            <Link href={module.docsUrl} target="_blank" rel="noreferrer">
              {module.modulePath}
            </Link>
          </Text>
        )}
      </HStack>
      {warning && <FieldStatus type="error" variant="detached" message={warning} />}
      <Text type="body" size="sm" color="secondary">
        {caddyModuleDescription(t, module)}
      </Text>
    </VStack>
  );
}

function RebuildBanner({
  build,
  rebuilding,
  onRebuild,
  inFlight,
  external,
}: {
  build: BuildResponse | null;
  rebuilding: boolean;
  onRebuild: () => void;
  inFlight: boolean;
  /** Every targeted agent loads an operator-built image, so the action is a load. */
  external: boolean;
}) {
  const t = useTranslations("caddyModules");
  const tRoot = useTranslations();
  if (!build) return null;
  const { diff, status } = build;

  if (!diff.needsRebuild && !inFlight && status.state !== "failed") {
    return (
      <Banner
        status="success"
        title={t("modulesCurrentStatus")}
        description={t("modulesCompiledIn", { count: diff.appliedSpecs.length })}
      />
    );
  }

  const bannerStatus = status.state === "failed" ? "error" : inFlight ? "info" : "warning";

  return (
    <Banner
      status={bannerStatus}
      icon={inFlight ? <Spinner size="sm" /> : undefined}
      title={
        inFlight
          ? (agentStatusMessage(tRoot, status) ?? t(external ? "loadingImage" : "rebuildingCaddy"))
          : status.state === "failed"
            ? t(external ? "lastLoadFailed" : "lastRebuildFailed")
            : t(external ? "imageRequired" : "rebuildRequired")
      }
      description={
        <VStack gap={2}>
          {status.state === "failed" && status.error && (
            <Text type="body" size="xsm">
              {status.error}
            </Text>
          )}
          {diff.added.length > 0 && (
            <HStack gap={1} wrap="wrap" vAlign="center">
              <Text type="body" size="sm">
                {t("adding")}
              </Text>
              {diff.added.map((spec) => (
                <Badge key={spec} label={spec} />
              ))}
            </HStack>
          )}
          {diff.removed.length > 0 && (
            <HStack gap={1} wrap="wrap" vAlign="center">
              <Text type="body" size="sm">
                {t("removing")}
              </Text>
              {diff.removed.map((spec) => (
                <Badge key={spec} label={spec} />
              ))}
            </HStack>
          )}
          {!inFlight && (
            <Text type="body" size="xsm" color="secondary">
              {t(external ? "externalRebuildDescription" : "rebuildDescription")}
            </Text>
          )}
        </VStack>
      }
      endContent={
        <Button
          variant="secondary"
          size="sm"
          icon={external ? <PackageCheck /> : <Hammer />}
          label={t(external ? "loadImage" : "rebuildCaddy")}
          isLoading={rebuilding}
          isDisabled={rebuilding || inFlight}
          onClick={onRebuild}
        />
      }
    />
  );
}
