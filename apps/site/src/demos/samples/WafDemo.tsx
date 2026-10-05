import { WafFields } from "@cpm/controller/src/components/proxy-hosts/waf/WafFields";
import { WafPresetOptionsProvider } from "@cpm/controller/src/components/proxy-hosts/waf/WafPresetOptions";
import { DemoSurface } from "../DemoSurface";

const PRESETS = [
  { id: 1, name: "Nextcloud", description: "WebDAV and editor exclusions" },
  { id: 2, name: "WordPress", description: "Admin and REST API exclusions" },
  { id: 3, name: "Immich", description: "Upload exclusions" },
];

const PLUGINS = [
  { id: 1, name: "wordpress-rule-exclusions", description: "CRS rule exclusions for WordPress" },
  { id: 2, name: "nextcloud-rule-exclusions", description: "CRS rule exclusions for Nextcloud" },
  { id: 3, name: "phpmyadmin-rule-exclusions", description: null },
];

/** A host past detect mode: one exclusion, a preset and a plugin. */
export default function WafDemo() {
  return (
    <DemoSurface>
      <WafPresetOptionsProvider presets={PRESETS} plugins={PLUGINS}>
        <WafFields
          value={{
            enabled: true,
            mode: "On",
            load_owasp_crs: true,
            waf_mode: "merge",
            excluded_rule_ids: [942100],
            preset_ids: [1],
            plugin_ids: [2],
            custom_directives:
              'SecRule REQUEST_HEADERS:User-Agent "@contains badbot" "id:9002,phase:1,deny,status:403,log"\n',
          }}
        />
      </WafPresetOptionsProvider>
    </DemoSurface>
  );
}
