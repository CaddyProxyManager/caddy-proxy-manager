/**
 * The name an agent confirms and stores a pairing under: the Application name, so the terminal
 * shows what the operator's browser does.
 */
import { appName } from "../settings/registry";
import { getSetting } from "../settings/resolve";

export async function controllerDisplayName(): Promise<string> {
  const name = await getSetting(appName).catch(() => appName.default);
  return name.trim() || appName.default;
}
