import { SettingsToggles } from "@cpm/controller/src/components/proxy-hosts/SettingsToggles";
import { DemoSurface } from "../DemoSurface";

export default function HostTogglesDemo() {
  return (
    <DemoSurface>
      <SettingsToggles hstsSubdomains={false} />
    </DemoSurface>
  );
}
