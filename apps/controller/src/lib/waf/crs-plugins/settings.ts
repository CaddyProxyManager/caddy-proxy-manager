/**
 * A JSON setting, not a registry entry: the registry is for values migrating out of `.env`. The
 * token is encrypted at rest and never leaves the server; readers get `hasGithubToken`.
 */

import { domainError } from "../../errors/domain-error";
import { decryptSecret, encryptSecret } from "../../secrets";
import { getSetting, setSetting } from "../../settings";
import { OFFICIAL_CRS_REGISTRY_URL } from "./registry";

const KEY = "crs_plugin_registry";

export const DEFAULT_REFRESH_INTERVAL_HOURS = 24;
export const MAX_REFRESH_INTERVAL_HOURS = 24 * 30;
export const MAX_REGISTRIES = 10;
const MAX_NAME_LENGTH = 64;

export type CrsRegistrySource = {
  /** Stable across renames: verdicts and listings are keyed by it. */
  id: string;
  name: string;
  url: string;
};

export const OFFICIAL_CRS_REGISTRY: CrsRegistrySource = {
  id: "official",
  name: "OWASP CRS",
  url: OFFICIAL_CRS_REGISTRY_URL,
};

/** As stored: the token encrypted. */
type StoredSettings = {
  registries: CrsRegistrySource[];
  refresh_interval_hours: number;
  github_token: string;
};

export type CrsRegistrySettings = {
  registries: CrsRegistrySource[];
  /** 0 turns the scheduled refresh off; registries are then read on demand only. */
  refreshIntervalHours: number;
  hasGithubToken: boolean;
};

export type CrsRegistrySettingsInput = {
  /** Without an id, a new registry; ids not listed are removed. */
  registries?: { id?: string | null; name: string; url: string }[];
  refreshIntervalHours?: number;
  /** A new token; "" removes the stored one; undefined keeps it. */
  githubToken?: string;
};

function isSource(value: unknown): value is CrsRegistrySource {
  const v = value as Partial<CrsRegistrySource>;
  return typeof v?.id === "string" && typeof v.name === "string" && typeof v.url === "string";
}

async function stored(): Promise<StoredSettings> {
  const value = await getSetting<Partial<StoredSettings>>(KEY);
  return {
    // Never saved: the official registry alone. Saved empty: none, which is the operator's call.
    registries: Array.isArray(value?.registries)
      ? value.registries.filter(isSource)
      : [OFFICIAL_CRS_REGISTRY],
    refresh_interval_hours: Number.isInteger(value?.refresh_interval_hours)
      ? (value?.refresh_interval_hours as number)
      : DEFAULT_REFRESH_INTERVAL_HOURS,
    github_token: typeof value?.github_token === "string" ? value.github_token : "",
  };
}

export async function getCrsRegistrySettings(): Promise<CrsRegistrySettings> {
  const value = await stored();
  return {
    registries: value.registries,
    refreshIntervalHours: value.refresh_interval_hours,
    hasGithubToken: value.github_token !== "",
  };
}

/** Decrypted, for the server's own GitHub requests only. */
export async function crsRegistryGithubToken(): Promise<string | null> {
  const token = (await stored()).github_token;
  return token ? decryptSecret(token, "CRS plugin registry GitHub token") : null;
}

function parseRegistryUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw domainError("crsRegistryUrlInvalid", { url: raw.trim() }, { status: 400 });
  }
  // The controller fetches it, so nothing that downgrades or reaches for a local file.
  if (url.protocol !== "https:" || url.username || url.password) {
    throw domainError("crsRegistryUrlInvalid", { url: raw.trim() }, { status: 400 });
  }
  return url.toString();
}

function parseRegistries(
  input: NonNullable<CrsRegistrySettingsInput["registries"]>,
  current: readonly CrsRegistrySource[],
): CrsRegistrySource[] {
  if (input.length > MAX_REGISTRIES) {
    throw domainError("crsRegistryTooMany", { max: String(MAX_REGISTRIES) }, { status: 400 });
  }
  const known = new Set(current.map((source) => source.id));
  const seenUrls = new Set<string>();
  const seenNames = new Set<string>();
  return input.map((raw) => {
    const name = raw.name.trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw domainError(
        "crsRegistryNameInvalid",
        { max: String(MAX_NAME_LENGTH) },
        { status: 400 },
      );
    }
    const url = parseRegistryUrl(raw.url);
    if (seenUrls.has(url)) throw domainError("crsRegistryDuplicate", { url }, { status: 400 });
    if (seenNames.has(name.toLowerCase())) {
      throw domainError("crsRegistryNameTaken", { name }, { status: 400 });
    }
    seenUrls.add(url);
    seenNames.add(name.toLowerCase());
    // An id the caller made up is not trusted to be unique; only an existing one is kept.
    const id =
      raw.id && known.has(raw.id)
        ? raw.id
        : url === OFFICIAL_CRS_REGISTRY_URL && !known.has(OFFICIAL_CRS_REGISTRY.id)
          ? OFFICIAL_CRS_REGISTRY.id
          : crypto.randomUUID();
    return { id, name, url };
  });
}

/** Returns whether the registries changed, so the caller knows to re-read them. */
export async function saveCrsRegistrySettings(input: CrsRegistrySettingsInput): Promise<boolean> {
  const current = await stored();
  const registries =
    input.registries !== undefined
      ? parseRegistries(input.registries, current.registries)
      : current.registries;
  const hours = input.refreshIntervalHours ?? current.refresh_interval_hours;
  if (!Number.isInteger(hours) || hours < 0 || hours > MAX_REFRESH_INTERVAL_HOURS) {
    throw domainError(
      "crsRegistryIntervalInvalid",
      { max: String(MAX_REFRESH_INTERVAL_HOURS) },
      { status: 400 },
    );
  }
  const token = input.githubToken?.trim();
  const githubToken =
    token === undefined ? current.github_token : token ? encryptSecret(token) : "";
  await setSetting<StoredSettings>(KEY, {
    registries,
    refresh_interval_hours: hours,
    github_token: githubToken,
  });
  return (
    JSON.stringify(registries) !== JSON.stringify(current.registries) ||
    githubToken !== current.github_token
  );
}
