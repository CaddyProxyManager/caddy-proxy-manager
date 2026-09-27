import { AdvancedConfigFields } from "@cpm/controller/src/components/proxy-hosts/AdvancedConfigFields";
import { DemoSurface } from "../DemoSurface";

/** The host editor's three raw-config escape hatches, which have no equivalent elsewhere. */
export default function HostEditorDemo() {
  return (
    <DemoSurface>
      <AdvancedConfigFields
        host={{
          customCaddyfile: `# Served before the reverse proxy, so /status never reaches the upstream.
handle /status* {
  respond "ok" 200
}`,
          customPreHandlersJson: `[{"handler": "headers", "response": {"set": {"X-Frame-Options": ["DENY"]}}}]`,
          customReverseProxyJson: "",
        }}
      />
    </DemoSurface>
  );
}
