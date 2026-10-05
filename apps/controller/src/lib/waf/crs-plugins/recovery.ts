/**
 * When Coraza cannot build the WAF, Caddy keeps its old config and every later change fails too,
 * so the culprit CRS plugin is switched off: the one whose range holds a quoted rule id, else all,
 * then back on one at a time (newest first). If all-off still fails, nothing stays off.
 */

import { logAuditEvent } from "../../audit";
import { CaddyApplyError } from "../../caddy/apply-error";
import {
  type CrsPluginQuarantine,
  getCrsPluginQuarantine,
  setCrsPluginQuarantine,
} from "./quarantine";

type Candidate = {
  id: number;
  name: string;
  version: string;
  ruleIdStart: number;
  ruleIdEnd: number;
  updatedAt: string;
};

function isWafRefusal(error: unknown): error is CaddyApplyError {
  return error instanceof CaddyApplyError && error.waf.wafFailed;
}

/** Runs `load`, switching off whichever selected CRS plugins make Caddy refuse it. */
export async function loadWithCrsPluginRecovery(load: () => Promise<void>): Promise<void> {
  try {
    await load();
  } catch (error) {
    if (!isWafRefusal(error)) throw error;
    if (!(await recover(error, load))) throw error;
  }
}

async function recover(error: CaddyApplyError, load: () => Promise<void>): Promise<boolean> {
  // Imported here: the model applies Caddy configs itself, so a static import would be a cycle.
  const { getCrsPluginUsage, listCrsPlugins } = await import("../../models/crs-plugins");
  const [plugins, usage, before] = await Promise.all([
    listCrsPlugins(),
    getCrsPluginUsage(),
    getCrsPluginQuarantine(),
  ]);
  const candidates: Candidate[] = plugins
    .filter((plugin) => usage.has(plugin.id) && !(plugin.id in before))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (candidates.length === 0) return false;

  const at = new Date().toISOString();
  const switchOff = (off: readonly Candidate[]) => {
    const next: CrsPluginQuarantine = { ...before };
    for (const plugin of off) next[plugin.id] = { at, version: plugin.version };
    return setCrsPluginQuarantine(next);
  };
  const loads = async () => {
    try {
      await load();
      return true;
    } catch (attempt) {
      if (isWafRefusal(attempt)) return false;
      throw attempt;
    }
  };

  try {
    const named = candidates.filter((plugin) =>
      error.waf.ruleIds.some((id) => id >= plugin.ruleIdStart && id <= plugin.ruleIdEnd),
    );
    if (named.length > 0) {
      await switchOff(named);
      if (await loads()) {
        await report(named);
        return true;
      }
    }

    await switchOff(candidates);
    if (!(await loads())) {
      await setCrsPluginQuarantine(before);
      return false;
    }

    const failed: Candidate[] = [];
    let lastLoaded = true;
    for (const [index, plugin] of candidates.entries()) {
      await switchOff([...failed, ...candidates.slice(index + 1)]);
      lastLoaded = await loads();
      if (!lastLoaded) failed.push(plugin);
    }
    await switchOff(failed);
    // The last attempt failing left Caddy on the one before; load what is now the settled set.
    if (!lastLoaded && !(await loads())) {
      await setCrsPluginQuarantine(before);
      return false;
    }
    await report(failed);
    return true;
  } catch (unexpected) {
    // Caddy unreachable part-way, say: nothing was learned, so nothing stays switched off.
    await setCrsPluginQuarantine(before);
    throw unexpected;
  }
}

async function report(disabled: readonly Candidate[]): Promise<void> {
  for (const plugin of disabled) {
    console.warn(`[crs-plugins] Caddy refused the WAF with ${plugin.name}; it is switched off`);
    await logAuditEvent({
      action: "update",
      entityType: "crs_plugin",
      entityId: plugin.id,
      summary: `Disabled CRS plugin ${plugin.name}: Caddy refused to load it`,
    });
    // Imported here, like the model above: the notifications reach the settings.
    const { reportCrsPluginDisabled } = await import("../../notifications/jobs");
    await reportCrsPluginDisabled(plugin);
  }
}
