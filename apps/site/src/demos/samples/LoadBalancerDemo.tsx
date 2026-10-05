import { LoadBalancerFields } from "@cpm/controller/src/components/proxy-hosts/upstreams/LoadBalancerFields";
import { DemoSurface } from "../DemoSurface";

/** Least-connections with both health checks on - the shape most people end up at. */
export default function LoadBalancerDemo() {
  return (
    <DemoSurface>
      <LoadBalancerFields
        loadBalancer={{
          enabled: true,
          policy: "least_conn",
          policyHeaderField: null,
          policyCookieName: null,
          policyCookieSecret: null,
          policyQueryKey: null,
          policyChoose: null,
          policyWeights: null,
          tryDuration: "5s",
          tryInterval: "250ms",
          retries: 2,
          activeHealthCheck: {
            enabled: true,
            uri: "/healthz",
            port: null,
            interval: "10s",
            timeout: "5s",
            status: 200,
            body: null,
            passes: null,
            fails: 2,
            method: null,
            requestBody: null,
            followRedirects: false,
            headers: null,
          },
          passiveHealthCheck: {
            enabled: true,
            failDuration: "30s",
            maxFails: 3,
            unhealthyStatus: null,
            unhealthyLatency: null,
            unhealthyRequestCount: null,
          },
        }}
      />
    </DemoSurface>
  );
}
