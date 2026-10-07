/**
 * Fetches this host's MaxMind databases from the controller, which holds the licence, signed with
 * the pairing secret. Pulled, not pushed, as they are tens of megabytes. Every agent fetches, the
 * bundled one too: the files land on the volume Caddy mounts read-only for geo-blocking.
 */

import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  CONTROLLER_GEOIP_ROUTE,
  GEOIP_EDITIONS,
  type GeoipEdition,
  signatureBase,
} from "@cpm/shared";
import type { AgentStore } from "../db";
import { geoipDir } from "./paths";

/** Generous: these are tens of megabytes over whatever link the controller is on. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Several times the largest edition. Only there so an endless body cannot fill the volume. */
export const MAX_DATABASE_BYTES = 200 * 1024 * 1024;

/** The edition names come from desired state and become a file name, so only known ones pass. */
export function isGeoipEdition(edition: unknown): edition is GeoipEdition {
  return (GEOIP_EDITIONS as readonly unknown[]).includes(edition);
}

function databasePath(edition: GeoipEdition): string {
  return join(geoipDir(), `${edition}.mmdb`);
}

/** The ETag key for an edition, so a re-check can be answered 304 instead of re-downloading. */
function etagKey(edition: string): string {
  return `geoip_etag:${edition}`;
}

/** Null fetches unconditionally: a tag means nothing once its file is gone. */
function conditionalEtag(store: AgentStore, edition: GeoipEdition): string | null {
  if (!existsSync(databasePath(edition))) return null;
  return store.parseState(etagKey(edition));
}

/**
 * Streams to a temporary name and renames into place, since Caddy has the directory open. Counted
 * while streaming, as Content-Length is the sender's claim and may be absent.
 */
export async function writeCappedDownload(
  response: Response,
  target: string,
  maxBytes = MAX_DATABASE_BYTES,
): Promise<number> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`declared ${declared} bytes, over the ${maxBytes} byte limit`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  const sink = Bun.file(temporary).writer();
  let written = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > maxBytes) {
          await reader.cancel();
          throw new Error(`body exceeded the ${maxBytes} byte limit`);
        }
        sink.write(value);
      }
    }
    await sink.end();
    renameSync(temporary, target);
    return written;
  } catch (error) {
    try {
      await sink.end();
    } catch {
      /* already closed */
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* the partial file is not worth a second failure */
    }
    throw error;
  }
}

/** Fetch one edition if the controller has a newer copy. */
async function syncEdition(
  store: AgentStore,
  controllerUrl: string,
  agentId: string,
  secret: string,
  edition: GeoipEdition,
): Promise<"updated" | "current" | "failed"> {
  const path = `${CONTROLLER_GEOIP_ROUTE}/${edition}`;
  const timestamp = Date.now();
  const emptyBody = new Bun.CryptoHasher("sha256").update("").digest("hex");
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(signatureBase("GET", path, timestamp, emptyBody, nonce))
    .digest("hex");

  const headers: Record<string, string> = {
    [AGENT_ID_HEADER]: agentId,
    [AGENT_TIMESTAMP_HEADER]: String(timestamp),
    [AGENT_NONCE_HEADER]: nonce,
    [AGENT_SIGNATURE_HEADER]: signature,
  };
  const known = conditionalEtag(store, edition);
  if (known) headers["if-none-match"] = known;

  let response: Response;
  try {
    // outbound: agentController
    response = await fetch(`${controllerUrl.replace(/\/+$/, "")}${path}`, {
      headers,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    // The controller is not reachable from here. Whatever database this host already has keeps
    // being used; country codes going stale is not worth a noisy failure every day.
    return "failed";
  }

  if (response.status === 304) return "current";
  if (!response.ok) return "failed";

  let size: number;
  try {
    size = await writeCappedDownload(response, databasePath(edition));
  } catch (error) {
    console.warn(`[geoip] could not install ${edition}:`, error);
    return "failed";
  }

  const etag = response.headers.get("etag");
  if (etag) store.setParseState(etagKey(edition), etag);
  console.log(`[geoip] updated ${edition} (${size} bytes)`);
  return "updated";
}

/** Never throws: an unreachable controller must not stop the agent recreating containers. */
export async function syncGeoipDatabases(
  store: AgentStore,
  controllerUrl: string,
  editions: unknown,
  agentId: string,
  secret: string,
): Promise<void> {
  if (!Array.isArray(editions)) return;
  for (const edition of editions) {
    if (!isGeoipEdition(edition)) {
      console.warn(`[geoip] ignoring unknown edition ${JSON.stringify(edition)}`);
      continue;
    }
    // Sequentially: each is tens of megabytes, and three at once over one link is slower than
    // three in a row while making the failure harder to read.
    const outcome = await syncEdition(store, controllerUrl, agentId, secret, edition);
    if (outcome === "failed") {
      console.warn(`[geoip] could not fetch ${edition} from ${controllerUrl}`);
    }
  }
}

/**
 * The paired origin first: the pushed one is the public `BASE_URL`, which for the bundled agent
 * goes through a Caddy it may not have started. The pushed URL's route suffix is stripped, since
 * the fetch appends it again.
 */
export function geoipControllerUrl(paired: string | null, pushed: string): string {
  if (paired) return paired;
  const url = pushed.replace(/\/+$/, "");
  return url.endsWith(CONTROLLER_GEOIP_ROUTE) ? url.slice(0, -CONTROLLER_GEOIP_ROUTE.length) : url;
}
