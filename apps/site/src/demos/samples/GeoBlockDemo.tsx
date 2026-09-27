import { GeoBlockFields } from "@cpm/controller/src/components/proxy-hosts/GeoBlockFields";
import { DemoSurface } from "../DemoSurface";
import { json, serveApi } from "../fake-api";

// Answers the GeoIP status fetch; at import, so it precedes the fields' fetch on mount.
if (typeof window !== "undefined") {
  serveApi(async (url) =>
    url.pathname === "/api/geoip-status" ? json({ enabled: true, country: true, asn: true }) : null,
  );
}

/** As the prose describes: a continent blocked, two exceptions let back through. */
export default function GeoBlockDemo() {
  return (
    <DemoSurface>
      <GeoBlockFields
        initialValues={{
          geoblock_mode: "merge",
          geoblock: {
            enabled: true,
            block_countries: ["CN", "RU"],
            block_continents: ["AF"],
            block_asns: [],
            block_cidrs: [],
            block_ips: [],
            allow_countries: [],
            allow_continents: [],
            allow_asns: [24940],
            allow_cidrs: ["91.98.150.0/24"],
            allow_ips: [],
            trusted_proxies: [],
            fail_closed: false,
            response_status: 403,
            response_body: "Forbidden",
            response_headers: {},
            redirect_url: "",
          },
        }}
      />
    </DemoSurface>
  );
}
