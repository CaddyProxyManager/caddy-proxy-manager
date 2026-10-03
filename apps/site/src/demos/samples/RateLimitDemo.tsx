import { RateLimitFields } from "@cpm/controller/src/components/proxy-hosts/RateLimitFields";
import { DemoSurface } from "../DemoSurface";

/** A tight limit on the sign-in form and a looser one on the API, the usual pair. */
export default function RateLimitDemo() {
  return (
    <DemoSurface>
      <RateLimitFields
        rateLimit={{
          enabled: true,
          zones: [
            { paths: ["/login"], maxEvents: 10, window: "1m", key: "ip", ipv6Prefix: 64 },
            { paths: ["/api/*"], maxEvents: 600, window: "1m", key: "ip+path", ipv6Prefix: null },
          ],
        }}
      />
    </DemoSurface>
  );
}
