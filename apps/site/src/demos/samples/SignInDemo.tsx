import LoginClient from "@cpm/controller/src/components/auth/LoginClient";
import { DemoSurface } from "../DemoSurface";

/**
 * `LoginClient` unchanged, its auth client a shim failing every attempt (shims/auth-client.ts):
 * the honest outcome with no controller, and where the kept username earns its place. Two
 * providers, one primary, so the `tonal` button has something to be set against.
 */
export default function SignInDemo() {
  return (
    <DemoSurface>
      {/* The screen centres itself in the full viewport height; the wrapper lets demo.css undo
          that inside a documentation page. */}
      <div className="cpm-demo-auth">
        <LoginClient
          enabledProviders={[
            { id: "authentik", name: "Authentik", isPrimary: true },
            { id: "github", name: "GitHub" },
          ]}
        />
      </div>
    </DemoSurface>
  );
}
