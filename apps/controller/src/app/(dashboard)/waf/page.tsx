export const dynamic = "force-dynamic";

import WafEventsClient from "./WafEventsClient";
import {
  listWafEvents,
  countWafEvents,
  getWafEventStats,
  getWafRuleMessages,
  type WafEventFilter,
} from "@/src/lib/models/waf-events";
import { getWafSettings } from "@/src/lib/settings";
import { stagedOverlay } from "@/src/lib/settings/staging";
import { withStagedReads } from "@/src/lib/settings/staging-context";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { getWafPresetUsage, listWafPresets, toWafPresetOption } from "@/src/lib/models/waf-presets";
import { WafPresetOptionsProvider } from "@/src/components/proxy-hosts/WafPresetOptions";
import {
  crsPluginLoadFailures,
  getCrsPluginUsage,
  listCrsPlugins,
  storedCrsPluginUpdates,
  toCrsPluginOption,
} from "@/src/lib/models/crs-plugins";
import { requireAdmin } from "@/src/lib/auth";
import { listDroppedWafDirectives } from "@/src/lib/caddy-waf";
import { strictId } from "@/src/lib/strict-id";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

const PER_PAGE = 50;
const RANGE_SECONDS = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
} as const;

type RangeKey = keyof typeof RANGE_SECONDS | "all" | "custom";

function parseRange(searchParams: { range?: string; from?: string; to?: string }): {
  range: RangeKey;
  from?: number;
  to?: number;
} {
  const rangeParam = searchParams.range;
  if (rangeParam === "24h" || rangeParam === "7d" || rangeParam === "30d") {
    const to = Math.floor(Date.now() / 1000);
    const from = to - RANGE_SECONDS[rangeParam];
    return { range: rangeParam, from, to };
  }

  if (rangeParam === "custom") {
    const from = parseInt(searchParams.from ?? "", 10);
    const to = parseInt(searchParams.to ?? "", 10);
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
      return { range: "custom", from, to };
    }
  }

  return { range: "all" };
}

interface PageProps {
  searchParams: Promise<{
    page?: string;
    search?: string;
    host?: string;
    ip?: string;
    rule?: string;
    action?: string;
    severity?: string;
    range?: string;
    from?: string;
    to?: string;
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("waf") };
}

export default async function WafPage({ searchParams }: PageProps) {
  const session = await requireAdmin();
  const resolvedSearchParams = await searchParams;
  const { page: pageParam, ...params } = resolvedSearchParams;
  const { range, from, to } = parseRange(resolvedSearchParams);
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const filter: WafEventFilter = {
    search: params.search?.trim() || undefined,
    host: params.host?.trim() || undefined,
    clientIp: params.ip?.trim() || undefined,
    ruleId: strictId(params.rule),
    blocked: params.action === "blocked" ? true : params.action === "detected" ? false : undefined,
    severity: params.severity?.trim() || undefined,
  };
  const offset = (page - 1) * PER_PAGE;

  // The form stages, so read against the staged set or an edit looks discarded after a reload.
  const overlay = await stagedOverlay(Number(session.user.id));

  const [
    events,
    total,
    stats,
    globalWaf,
    hosts,
    presets,
    presetUsage,
    plugins,
    pluginUsage,
    pluginUpdates,
    pluginFailures,
  ] = await Promise.all([
    listWafEvents(PER_PAGE, offset, filter, from, to),
    countWafEvents(filter, from, to),
    getWafEventStats(filter, from, to),
    withStagedReads(overlay, () => getWafSettings()),
    listProxyHosts(),
    listWafPresets(),
    withStagedReads(overlay, () => getWafPresetUsage()),
    listCrsPlugins(),
    withStagedReads(overlay, () => getCrsPluginUsage()),
    storedCrsPluginUpdates(),
    crsPluginLoadFailures(),
  ]);

  const globalExcludedIds = globalWaf?.excluded_rule_ids ?? [];
  const globalExcludedMessages = await getWafRuleMessages(globalExcludedIds);

  const hostWafMap: Record<string, number[]> = {};
  for (const host of hosts) {
    const ids = host.waf?.excluded_rule_ids ?? [];
    for (const domain of host.domains) {
      hostWafMap[domain] = ids;
    }
  }

  return (
    <WafPresetOptionsProvider
      presets={presets.map(toWafPresetOption)}
      plugins={plugins.map(toCrsPluginOption)}
    >
      <WafEventsClient
        events={events}
        stats={stats}
        pagination={{ total, page, perPage: PER_PAGE }}
        hostOptions={[...new Set(hosts.flatMap((host) => host.domains))].sort()}
        initialRange={range}
        initialFrom={from ?? null}
        initialTo={to ?? null}
        globalExcluded={globalExcludedIds}
        globalExcludedMessages={globalExcludedMessages}
        globalWafEnabled={globalWaf?.enabled ?? false}
        hostWafMap={hostWafMap}
        globalWaf={globalWaf ?? null}
        presets={presets.map((preset) => {
          const usage = presetUsage.get(preset.id);
          return {
            id: preset.id,
            name: preset.name,
            description: preset.description,
            directives: preset.directives,
            updatedAt: preset.updatedAt,
            usedGlobally: usage?.global ?? false,
            usedByDashboard: usage?.dashboard ?? false,
            hostCount: usage?.hosts.length ?? 0,
          };
        })}
        pluginUpdates={Object.fromEntries(pluginUpdates)}
        droppedDirectives={listDroppedWafDirectives(globalWaf ?? null, hosts)}
        plugins={plugins.map((plugin) => {
          const usage = pluginUsage.get(plugin.id);
          return {
            id: plugin.id,
            name: plugin.name,
            description: plugin.description,
            repository: plugin.repository,
            version: plugin.version,
            ruleIdStart: plugin.ruleIdStart,
            ruleIdEnd: plugin.ruleIdEnd,
            configRules: plugin.configRules,
            beforeRules: plugin.beforeRules,
            afterRules: plugin.afterRules,
            configOverride: plugin.configOverride,
            fileNames: plugin.fileNames,
            loadFailedAt: pluginFailures.get(plugin.id)?.at ?? null,
            updatedAt: plugin.updatedAt,
            usedGlobally: usage?.global ?? false,
            usedByDashboard: usage?.dashboard ?? false,
            hostCount: usage?.hosts.length ?? 0,
          };
        })}
      />
    </WafPresetOptionsProvider>
  );
}
