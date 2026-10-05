import { RateLimitFields } from "@cpm/controller/src/components/proxy-hosts/protection/RateLimitFields";
import { DemoSurface } from "../DemoSurface";

/**
 * A tight limit on posts to the sign-in form and a per-key one on the API, on top of the global
 * zones.
 */
export default function RateLimitDemo() {
  return (
    <DemoSurface>
      <RateLimitFields
        rateLimit={{
          enabled: true,
          mode: "merge",
          zones: [
            {
              paths: ["/login"],
              methods: ["POST"],
              maxEvents: 10,
              window: "1m",
              key: "ip",
              header: null,
              ipv6Prefix: 64,
            },
            {
              paths: ["/api/*"],
              methods: [],
              maxEvents: 600,
              window: "1m",
              key: "header",
              header: "X-Api-Key",
              ipv6Prefix: null,
            },
          ],
        }}
      />
    </DemoSurface>
  );
}
