/**
 * GET /api/agent/geoip/:edition - a MaxMind database for a paired agent, so no host needs its own
 * licence key. Signed with the pairing secret; anything else gets 404, not 401, so neither the
 * route nor real agent ids can be learned without a secret.
 */

import { existsSync, statSync } from "node:fs";
import { GEOIP_EDITIONS, type GeoipEdition } from "@cpm/shared";
import type { NextRequest } from "next/server";
import { verifyAgentRequest } from "@/src/lib/agent/verify";
import { geoipDatabasePath, geoipEtag } from "@/src/lib/agent/geoip";

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ edition: string }> },
) {
  const { edition } = await params;
  // Before authentication, so an unknown edition cannot probe which agent ids verify.
  if (!(GEOIP_EDITIONS as readonly string[]).includes(edition)) return notFound();

  // GET, so the signed body is the empty string - the same value the agent hashed.
  const verified = await verifyAgentRequest(request, "");
  const agent = verified.ok ? verified.agent : null;
  if (!agent) return notFound();

  const path = geoipDatabasePath(edition as GeoipEdition);
  if (!existsSync(path)) return notFound();

  const etag = geoipEtag(path);
  // A remote agent re-checks daily; otherwise each check moves tens of megabytes for nothing.
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(statSync(path).size),
      ETag: etag,
      "Cache-Control": "no-store",
    },
  });
}
