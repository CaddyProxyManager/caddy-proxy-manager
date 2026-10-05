import { UpstreamDnsResolutionFields } from "@cpm/controller/src/components/proxy-hosts/upstreams/UpstreamDnsResolutionFields";
import { DemoSurface } from "../DemoSurface";

/** Left inheriting, so the disclosure shows what a host says when it overrides nothing. */
export default function UpstreamDnsDemo() {
  return (
    <DemoSurface>
      <UpstreamDnsResolutionFields />
    </DemoSurface>
  );
}
