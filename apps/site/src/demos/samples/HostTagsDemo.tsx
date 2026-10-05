import { HostTagsField } from "@cpm/controller/src/components/proxy-hosts/HostTagsField";
import { DemoSurface } from "../DemoSurface";

/** The editor's tag field, starting with two tags a production web host might carry. */
export default function HostTagsDemo() {
  return (
    <DemoSurface>
      <HostTagsField initial={["prod", "team:web"]} />
    </DemoSurface>
  );
}
