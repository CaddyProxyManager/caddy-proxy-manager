import {
  HostTagSuggestions,
  HostTagsField,
} from "@cpm/controller/src/components/proxy-hosts/HostTagsField";
import { DemoSurface } from "../DemoSurface";

/** Tags other hosts already carry, offered as suggestions while typing. */
const IN_USE = ["internal", "monitoring", "prod", "staging", "team:data", "team:web"];

/** The editor's tag field, starting with two tags a production web host might carry. */
export default function HostTagsDemo() {
  return (
    <DemoSurface>
      <HostTagSuggestions tags={IN_USE}>
        <HostTagsField initial={["prod", "team:web"]} />
      </HostTagSuggestions>
    </DemoSurface>
  );
}
