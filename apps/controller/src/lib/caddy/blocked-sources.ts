/**
 * The global deny list as the first handlers of every HTTP host. Addresses use Caddy's own
 * `client_ip` matcher, so they need no plugin and follow the server's trusted proxies; countries,
 * continents and networks need the blocker module and its GeoIP databases.
 */

import type { BlockedSourceKind } from "../blocked-sources/types";
import { tagOutcome } from "./outcome-markers";

export type ActiveBlockedSource = { kind: BlockedSourceKind; value: string };

export const BLOCKED_STATUS = 403;
export const BLOCKED_BODY = "Forbidden";

type Handler = Record<string, unknown>;

export function buildBlockedSourceHandlers(
  sources: readonly ActiveBlockedSource[],
  options: { geoUsable: boolean; trustedProxies?: readonly string[] },
): { handlers: Handler[]; skippedGeo: number } {
  const ranges = [
    ...new Set(sources.filter((s) => s.kind === "ip" || s.kind === "cidr").map((s) => s.value)),
  ];
  const of = (kind: BlockedSourceKind) => [
    ...new Set(sources.filter((s) => s.kind === kind).map((s) => s.value)),
  ];
  const countries = of("country");
  const continents = of("continent");
  const asns = of("asn")
    .map(Number)
    .filter((asn) => Number.isInteger(asn) && asn > 0);
  const geoCount = countries.length + continents.length + asns.length;

  const handlers: Handler[] = [];
  if (ranges.length > 0) {
    handlers.push(
      tagOutcome(
        {
          handler: "subroute",
          routes: [
            {
              match: [{ client_ip: { ranges } }],
              handle: [
                { handler: "static_response", status_code: BLOCKED_STATUS, body: BLOCKED_BODY },
              ],
            },
          ],
        },
        "blocked",
      ),
    );
  }
  if (geoCount > 0 && options.geoUsable) {
    const blocker: Handler = {
      handler: "blocker",
      geoip_db: "/usr/share/GeoIP/GeoLite2-Country.mmdb",
      asn_db: "/usr/share/GeoIP/GeoLite2-ASN.mmdb",
      response_status: BLOCKED_STATUS,
      response_body: BLOCKED_BODY,
    };
    if (countries.length > 0) blocker.block_countries = countries;
    if (continents.length > 0) blocker.block_continents = continents;
    if (asns.length > 0) blocker.block_asns = asns;
    if (options.trustedProxies?.length) blocker.trusted_proxies = [...options.trustedProxies];
    handlers.push(tagOutcome(blocker, "blocked"));
  }
  return { handlers, skippedGeo: options.geoUsable ? 0 : geoCount };
}
