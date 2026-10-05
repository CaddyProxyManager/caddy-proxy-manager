import { UpstreamInput } from "@cpm/controller/src/components/proxy-hosts/upstreams/UpstreamInput";
import { DemoSurface } from "../DemoSurface";

/** Two upstreams, which is the smallest number that makes the load balancer worth configuring. */
export default function UpstreamsDemo() {
  return (
    <DemoSurface>
      <UpstreamInput defaultUpstreams={["http://app-1:8080", "http://app-2:8080"]} />
    </DemoSurface>
  );
}
