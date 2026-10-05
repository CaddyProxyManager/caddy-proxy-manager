import { LocationRulesFields } from "@cpm/controller/src/components/proxy-hosts/routing/LocationRulesFields";
import { DemoSurface } from "../DemoSurface";

/** The lists a host editor would offer; with none passed, the per-path choice is not shown. */
const ACCESS_LISTS = [
  { id: 1, name: "Staging" },
  { id: 2, name: "Ops tools" },
];

/** The example from the prose above: an API and a websocket endpoint on separate backends. */
export default function LocationRulesDemo() {
  return (
    <DemoSurface>
      <LocationRulesFields
        accessLists={ACCESS_LISTS}
        initialData={[
          { path: "/api/*", upstreams: ["http://api:3000"], loadBalancer: null },
          {
            path: "/ws/*",
            upstreams: ["http://realtime:8000"],
            loadBalancer: null,
            accessListId: 2,
          },
        ]}
      />
    </DemoSurface>
  );
}
