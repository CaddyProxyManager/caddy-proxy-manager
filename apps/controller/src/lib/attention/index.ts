/**
 * Needs attention: every provider runs in parallel under its own budget, and one still running at
 * the budget is named in `skipped` rather than waited for, so the overview never hangs on a slow
 * agent or directory. Items are filtered to what the viewer may see, worst first, capped.
 */

import { type Access, can, canReach, canView } from "../users/permissions";
import {
  ATTENTION_PROVIDER_LIST,
  type AttentionProvider,
  type HostRef,
  type ProviderResult,
} from "./providers";
import {
  ATTENTION_LIMIT,
  ATTENTION_PROVIDER_BUDGET_MS,
  type AttentionItem,
  type AttentionList,
  type AttentionProviderId,
  sortAttention,
} from "./types";

export * from "./types";

/** The providers whose items can name a proxy host; the rest never reach a host's page. */
const HOST_PROVIDERS: readonly AttentionProviderId[] = ["certificates", "traffic"];

async function withinBudget(
  provider: AttentionProvider,
  run: () => Promise<ProviderResult>,
  budgetMs: number,
): Promise<ProviderResult | null> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
      // Cancels the provider's ClickHouse queries rather than leaving them to finish unread.
      abort.abort();
    }, budgetMs);
  });
  const { withQueryAbort } = await import("../clickhouse/client");
  try {
    return await Promise.race([withQueryAbort(abort.signal, run), deadline]);
  } catch (error) {
    console.warn(`[attention] the ${provider.id} provider failed:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whoever holds the overview sees everything; anyone else what touches a host or agent they may
 * view. An item naming neither is about the instance, so it needs the overview.
 */
export function visibleTo(access: Access, item: AttentionItem): boolean {
  if (can(access, "overview:read")) return true;
  const hosts = item.scope.proxyHosts ?? [];
  if (hosts.some((id) => canView(access, "proxyHost", id))) return true;
  return item.scope.agent !== undefined && canView(access, "agent", item.scope.agent);
}

/** Nothing to show without the overview or some host or agent to see. */
function seesAny(access: Access): boolean {
  return (
    can(access, "overview:read") ||
    canReach(access, "hosts:read") ||
    canReach(access, "agents:read")
  );
}

async function loadHostRefs(): Promise<HostRef[]> {
  const [{ default: db }, { proxyHosts }] = await Promise.all([
    import("../db"),
    import("../db/schema"),
  ]);
  const rows = await db
    .select({
      id: proxyHosts.id,
      uuid: proxyHosts.uuid,
      name: proxyHosts.name,
      domains: proxyHosts.domains,
      enabled: proxyHosts.enabled,
      certificateId: proxyHosts.certificateId,
    })
    .from(proxyHosts);
  return rows.map((row) => {
    let domains: string[] = [];
    try {
      const parsed = JSON.parse(row.domains) as unknown;
      if (Array.isArray(parsed)) domains = parsed.filter((d): d is string => typeof d === "string");
    } catch {
      // A malformed row names no domain.
    }
    return { ...row, uuid: row.uuid ?? "", domains };
  });
}

export type AttentionOptions = {
  /** Only items about this proxy host, from the providers that can name one. */
  proxyHostId?: number;
  now?: number;
  budgetMs?: number;
  /** Test seam. */
  providers?: readonly AttentionProvider[];
};

export async function collectAttention(
  access: Access,
  options: AttentionOptions = {},
): Promise<AttentionList> {
  if (!seesAny(access)) return { items: [], skipped: [], truncated: 0 };
  const now = options.now ?? Date.now();
  let hosts: Promise<HostRef[]> | null = null;
  const context = {
    now,
    hosts: () => {
      hosts ??= loadHostRefs();
      return hosts;
    },
  };
  const providers = (options.providers ?? ATTENTION_PROVIDER_LIST).filter(
    (provider) =>
      (!provider.adminOnly || can(access, "overview:read")) &&
      (options.proxyHostId === undefined || HOST_PROVIDERS.includes(provider.id)),
  );

  const results = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      result: await withinBudget(
        provider,
        () => provider.run(context),
        options.budgetMs ?? ATTENTION_PROVIDER_BUDGET_MS,
      ),
    })),
  );

  const skipped: AttentionProviderId[] = [];
  const items: AttentionItem[] = [];
  for (const { provider, result } of results) {
    if (result === null) {
      skipped.push(provider.id);
      continue;
    }
    if (result.partial) skipped.push(provider.id);
    for (const item of result.items) {
      if (!visibleTo(access, item)) continue;
      if (
        options.proxyHostId !== undefined &&
        !(item.scope.proxyHosts ?? []).includes(options.proxyHostId)
      ) {
        continue;
      }
      items.push(item);
    }
  }
  const sorted = sortAttention(items);
  return {
    items: sorted.slice(0, ATTENTION_LIMIT),
    skipped,
    truncated: Math.max(0, sorted.length - ATTENTION_LIMIT),
  };
}
