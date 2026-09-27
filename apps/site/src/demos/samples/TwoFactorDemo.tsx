import { TwoFactorSection } from "@cpm/controller/src/app/(dashboard)/profile/TwoFactorSection";
import { DemoSurface } from "../DemoSurface";

/** The real Profile section; the auth-client shim takes any password and any six digits. */
export default function TwoFactorDemo() {
  return (
    <DemoSurface>
      <TwoFactorSection enabled={false} hasPassword locked={false} />
    </DemoSurface>
  );
}
