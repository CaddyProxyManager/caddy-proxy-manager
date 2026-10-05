/**
 * Read the public address here, not from `config.baseUrl` (the environment alone). Settings load
 * lazily: they read process.env on first load, which a static import freezes before tests set it.
 */
import { config } from "../config";

/** No trailing slash; BASE_URL when settings cannot be read. */
export async function getPublicBaseUrl(): Promise<string> {
  try {
    const [{ baseUrl }, { getSetting }] = await Promise.all([
      import("../settings/registry"),
      import("../settings/resolve"),
    ]);
    return (await getSetting(baseUrl)).replace(/\/+$/, "");
  } catch {
    return config.baseUrl.replace(/\/+$/, "");
  }
}

/** BASE_URL's too: an operator who just stored a new Public URL is still on the old address. */
export async function publicOrigins(): Promise<string[]> {
  const origins = new Set<string>();
  for (const url of [config.baseUrl, await getPublicBaseUrl()]) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // Settings validation refuses it elsewhere; trust nothing for it.
    }
  }
  return [...origins];
}

export async function isPublicOrigin(origin: string | null): Promise<boolean> {
  if (!origin) return false;
  return (await publicOrigins()).includes(origin);
}
