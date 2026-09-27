"use client";

/** Save only records; Rebuild restarts the proxy, hence two separately-confirmed buttons. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Hammer, Plus, Trash2 } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@/components/ui/FormBooleanControls";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { useTranslations } from "next-intl";
import {
  CADDY_MODULES,
  type CaddyCustomModule,
  type CaddyModuleCategory,
  type CaddyModuleDefinition,
  customModuleProblem,
  customModuleSpec,
  validateCustomModule,
} from "@/src/lib/caddy-modules";
import { caddyModuleDescription, caddyModuleName } from "@/src/lib/caddy-module-messages";
import { extractErrorMessage } from "@/src/lib/actions";

type BuildStatus = {
  state: "idle" | "pending" | "building" | "applied" | "failed";
  message?: string;
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

type BuildResponse = { diff: BuildDiff; status: BuildStatus };

type CustomModuleRow = CaddyCustomModule & { uid: string };

let rowIdCounter = 0;
const nextRowId = () => `custom-${++rowIdCounter}`;

const CATEGORY_LABEL_KEYS: Record<
  CaddyModuleCategory,
  "categoryProxy" | "categorySecurity" | "categoryDns"
> = {
  proxy: "categoryProxy",
  security: "categorySecurity",
  dns: "categoryDns",
};

const CATEGORY_ORDER: CaddyModuleCategory[] = ["proxy", "security", "dns"];

function groupModules(): [CaddyModuleCategory, CaddyModuleDefinition[]][] {
  return CATEGORY_ORDER.map((category) => [
    category,
    CADDY_MODULES.filter((m) => m.category === category),
  ]);
}

/** Zero is never an `agents.id`, so it cannot collide. */
const FLEET = 0;

function resolveModuleMap(overrides: Record<string, boolean>): Record<string, boolean> {
  const resolved: Record<string, boolean> = {};
  for (const module of CADDY_MODULES) {
    // Missing means enabled, so a module added to the catalog since the last save is on.
    resolved[module.id] = overrides[module.id] !== false;
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

  const dockerfilePreview = useMemo(
    () =>
      [
        "# The build argument the rebuild passes to docker/caddy/Dockerfile.",
        "# Copy this into your own build if you would rather not use the agent:",
        '#   docker compose build --build-arg CADDY_MODULES="..." caddy',
        "",
        "xcaddy build controller \\",
        ...previewSpecs.map((spec) => `  --with ${spec} \\`),
        "  --output /usr/bin/caddy",
      ].join("\n"),
    [previewSpecs],
  );

  const handleRebuild = async () => {
    setRebuilding(true);
    setRebuildError(null);
    try {
      const res = await fetch(
        target === FLEET ? "/api/caddy-build" : `/api/caddy-build?agent=${target}`,
        { method: "POST" },
      );
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
      { modulePath: "", version: "", enabled: true, uid: nextRowId() },
    ]);

  const updateCustomModule = (uid: string, patch: Partial<CaddyCustomModule>) =>
    setCustomModules((prev) => prev.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));

  const removeCustomModule = (uid: string) =>
    setCustomModules((prev) => prev.filter((c) => c.uid !== uid));

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
      />

      <Banner
        status="info"
        title={t("rebuildRequiredTitle")}
        description={t("rebuildRequiredDescription")}
      />

      {groupModules().map(([category, group]) => (
        <Card key={category} padding={4}>
          <VStack gap={3}>
            <HStack justify="between" align="center">
              <Heading level={2}>{t(CATEGORY_LABEL_KEYS[category])}</Heading>
              <Badge label={`${group.filter((m) => modules[m.id]).length}/${group.length}`} />
            </HStack>
            <Divider />
            {group.map((module) => (
              <ModuleToggle
                key={module.id}
                module={module}
                value={modules[module.id] ?? true}
                onChange={(next) => setModules((prev) => ({ ...prev, [module.id]: next }))}
              />
            ))}
          </VStack>
        </Card>
      ))}

      <Card padding={4}>
        <VStack gap={3}>
          <Heading level={2}>{t("customModulesTitle")}</Heading>
          <Divider />
          <Text type="body" size="xsm" color="secondary">
            {t("customModuleHelp")}
          </Text>

          {customModules.length === 0 && (
            <Text type="body" size="sm" color="secondary">
              {t("noCustomModules")}
            </Text>
          )}

          {customModules.map((entry) => {
            const problem = entry.modulePath.trim() ? customModuleProblem(entry) : null;
            const error = problem ? extractErrorMessage(tRoot, problem, problem.message) : null;
            return (
              <Card key={entry.uid} variant="muted" padding={3}>
                <VStack gap={2}>
                  <HStack gap={2} align="end" wrap="wrap">
                    <TextInput
                      label={t("modulePath")}
                      value={entry.modulePath}
                      onChange={(next) => updateCustomModule(entry.uid, { modulePath: next })}
                      placeholder={t("modulePathPlaceholder")}
                      status={error ? { type: "error", message: error } : undefined}
                    />
                    <TextInput
                      label={t("version")}
                      value={entry.version ?? ""}
                      onChange={(next) => updateCustomModule(entry.uid, { version: next })}
                      placeholder="latest"
                      description={t("moduleVersionHelp")}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 />}
                      label={t("remove")}
                      isIconOnly
                      onClick={() => removeCustomModule(entry.uid)}
                    />
                  </HStack>
                  <Switch
                    label={t("includeModuleLabel")}
                    value={entry.enabled}
                    onChange={(next) => updateCustomModule(entry.uid, { enabled: next })}
                  />
                </VStack>
              </Card>
            );
          })}

          <HStack justify="start">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus />}
              label={t("addModule")}
              onClick={addCustomModule}
            />
          </HStack>
        </VStack>
      </Card>

      <CodeEditor
        label={t("buildCommandPreview")}
        language="dockerfile"
        value={dockerfilePreview}
        isReadOnly
        height="md"
        description={t("modulesSelected", { count: enabledCount })}
      />

      {/* The controls above are React state; these carry it to the server action. */}
      {CADDY_MODULES.map((module) => (
        <input
          key={module.id}
          type="hidden"
          name={`module:${module.id}`}
          value={modules[module.id] ? "on" : ""}
        />
      ))}
      <input
        type="hidden"
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
  value,
  onChange,
}: {
  module: CaddyModuleDefinition;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <VStack gap={1}>
      <Switch label={caddyModuleName(t, module)} value={value} onChange={onChange} />
      <Text type="body" size="xsm" color="secondary">
        {caddyModuleDescription(t, module)}{" "}
        {module.docsUrl && (
          <Link href={module.docsUrl} target="_blank" rel="noreferrer">
            {module.modulePath}
          </Link>
        )}
      </Text>
    </VStack>
  );
}

function RebuildBanner({
  build,
  rebuilding,
  onRebuild,
  inFlight,
}: {
  build: BuildResponse | null;
  rebuilding: boolean;
  onRebuild: () => void;
  inFlight: boolean;
}) {
  const t = useTranslations("caddyModules");
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
          ? (status.message ?? t("rebuildingCaddy"))
          : status.state === "failed"
            ? t("lastRebuildFailed")
            : t("rebuildRequired")
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
              {t("rebuildDescription")}
            </Text>
          )}
        </VStack>
      }
      endContent={
        <Button
          variant="secondary"
          size="sm"
          icon={<Hammer />}
          label={t("rebuildCaddy")}
          isLoading={rebuilding}
          isDisabled={rebuilding || inFlight}
          onClick={onRebuild}
        />
      }
    />
  );
}
