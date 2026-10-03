import { UpstreamTimeoutsFields } from "@cpm/controller/src/components/proxy-hosts/UpstreamTimeoutsFields";
import { DemoSurface } from "../DemoSurface";

/** A slow report endpoint and a long-lived WebSocket, the two usual reasons to change them. */
export default function UpstreamTimeoutsDemo() {
  return (
    <DemoSurface>
      <UpstreamTimeoutsFields
        upstreamTimeouts={{
          dialTimeout: "5s",
          responseHeaderTimeout: "5m",
          readTimeout: null,
          writeTimeout: null,
          keepAliveIdleTimeout: null,
          streamTimeout: "24h",
          streamCloseDelay: "10m",
        }}
      />
    </DemoSurface>
  );
}
