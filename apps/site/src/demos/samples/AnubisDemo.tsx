import { AnubisFields } from "@cpm/controller/src/components/proxy-hosts/AnubisFields";
import { DemoSurface } from "../DemoSurface";

/** A challenged site whose API stays open to scripts. */
export default function AnubisDemo() {
  return (
    <DemoSurface>
      <AnubisFields
        anubis={{ enabled: true, upstream: "http://anubis:8923", exemptPaths: ["/api/*"] }}
      />
    </DemoSurface>
  );
}
