import { UpstreamHealthPanel } from "@cpm/controller/src/components/proxy-hosts/upstreams/UpstreamHealthPanel";
import { DemoSurface } from "../DemoSurface";

/** The editor's live health panel; the shimmed action answers for two agents, one offline. */
export default function UpstreamHealthDemo() {
  return (
    <DemoSurface>
      <UpstreamHealthPanel hostId={1} />
    </DemoSurface>
  );
}
