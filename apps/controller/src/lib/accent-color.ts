/**
 * The stored accent colour, for the root layout. Settings are imported lazily for the same reason
 * as `getAppName`; any failure falls back to pink, since the page must render without a database.
 */
import { type AccentColor, DEFAULT_ACCENT_COLOR, isAccentColor } from "./accent-colors";

export async function getAccentColor(): Promise<AccentColor> {
  try {
    const [{ accentColor }, { getSetting }] = await Promise.all([
      import("./settings/registry"),
      import("./settings/resolve"),
    ]);
    const value = await getSetting(accentColor);
    return isAccentColor(value) ? value : DEFAULT_ACCENT_COLOR;
  } catch {
    return DEFAULT_ACCENT_COLOR;
  }
}
