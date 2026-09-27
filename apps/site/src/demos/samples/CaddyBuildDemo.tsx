import { CaddyBuildFields } from "@cpm/controller/src/components/caddy-modules/CaddyBuildFields";
import { CADDY_MODULES } from "@cpm/controller/src/lib/caddy-modules";
import { DemoSurface } from "../DemoSurface";
import { json, serveApi } from "../fake-api";

const INITIAL_MODULES: Record<string, boolean> = { "github.com/mholt/caddy-l4": false };

/** What the running Caddy was built with: every module but the one switched off above. */
const APPLIED = CADDY_MODULES.filter((module) => INITIAL_MODULES[module.id] !== false)
  .map((module) => module.modulePath)
  .sort();

// Registered at import, so it is in place before the fields ask on mount. Nothing is saved, so
// wanted always equals built and Rebuild never appears.
if (typeof window !== "undefined") {
  serveApi(async (url) =>
    url.pathname === "/api/caddy-build"
      ? json({
          diff: {
            appliedSpecs: APPLIED,
            desiredSpecs: APPLIED,
            added: [],
            removed: [],
            needsRebuild: false,
          },
          status: { state: "applied", appliedAt: "2026-09-20T09:12:00Z" },
        })
      : null,
  );
}

/**
 * The real module picker, with the build it reports on answered in the browser. The selection is
 * the part worth showing, and saving it - which is what would offer a rebuild - needs a controller.
 */
export default function CaddyBuildDemo() {
  return (
    <DemoSurface>
      <CaddyBuildFields initialModules={INITIAL_MODULES} initialCustomModules={[]} />
    </DemoSurface>
  );
}
