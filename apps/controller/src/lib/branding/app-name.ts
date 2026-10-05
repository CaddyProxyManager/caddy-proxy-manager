/**
 * What this instance calls itself: the stored Application name, else APP_NAME. Read here, not
 * from `config.appName`, which is fixed for the process. Settings are imported lazily because
 * they read process.env on first load, and a static import would freeze that before tests.
 */
import { config } from "../config";

export async function getAppName(): Promise<string> {
  try {
    const [{ appName }, { getSetting }] = await Promise.all([
      import("../settings/registry"),
      import("../settings/resolve"),
    ]);
    const name = (await getSetting(appName)).trim();
    return name || config.appName;
  } catch {
    return config.appName;
  }
}
