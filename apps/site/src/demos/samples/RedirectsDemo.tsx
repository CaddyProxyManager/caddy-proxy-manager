import { PathRewritesFields } from "@cpm/controller/src/components/proxy-hosts/routing/PathRewritesFields";
import { RedirectsFields } from "@cpm/controller/src/components/proxy-hosts/routing/RedirectsFields";
import { VStack } from "@astryxdesign/core/Stack";
import { DemoSurface } from "../DemoSurface";

/** Two controls on one form, easier to tell apart side by side. */
export default function RedirectsDemo() {
  return (
    <DemoSurface>
      <VStack gap={6}>
        <RedirectsFields
          initialData={[
            { from: "/.well-known/carddav", to: "/remote.php/dav/", status: 301 },
            {
              from: "/blog/*",
              to: "https://blog.example.com",
              status: 308,
              preservePath: "suffix",
            },
          ]}
        />
        <PathRewritesFields initialData={[{ from: "/legacy", to: "/v2" }]} />
      </VStack>
    </DemoSurface>
  );
}
