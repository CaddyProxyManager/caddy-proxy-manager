/**
 * Install checks read rules without compiling them, so a plugin Coraza cannot build would stop
 * every host's config loading. A settings row, not a column: it is written mid-recovery and
 * concerns the running Caddy, not the plugin as installed.
 */

import { getSetting, setSetting } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";

const KEY = "crs_plugin_quarantine";

export type CrsPluginLoadFailure = {
  at: string;
  /** A different release is worth trying again. */
  version: string;
};

export type CrsPluginQuarantine = Record<number, CrsPluginLoadFailure>;

export async function getCrsPluginQuarantine(): Promise<CrsPluginQuarantine> {
  return (await outsideStagingScope(() => getSetting<CrsPluginQuarantine>(KEY))) ?? {};
}

export async function setCrsPluginQuarantine(quarantine: CrsPluginQuarantine): Promise<void> {
  await outsideStagingScope(() => setSetting(KEY, quarantine));
}

/** Lets a plugin load again: after an update, a config edit, an uninstall or a retry. */
export async function releaseCrsPlugin(id: number): Promise<boolean> {
  const quarantine = await getCrsPluginQuarantine();
  if (!(id in quarantine)) return false;
  delete quarantine[id];
  await setCrsPluginQuarantine(quarantine);
  return true;
}
