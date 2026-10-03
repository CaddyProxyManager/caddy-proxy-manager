import { CrowdSecFields } from "@cpm/controller/src/components/proxy-hosts/CrowdSecFields";
import { DemoSurface } from "../DemoSurface";

/** The per-host switch as every host starts: following the global setting. */
export default function CrowdSecDemo() {
  return (
    <DemoSurface>
      <CrowdSecFields enabled />
    </DemoSurface>
  );
}
