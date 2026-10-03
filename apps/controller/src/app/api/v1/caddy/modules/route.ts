import { type NextRequest, NextResponse } from "next/server";
import { pushDesiredState } from "@/src/lib/agent/desired-state";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api-auth";
import { getCaddyBuildDiff, sanitizeCaddyBuildSettings } from "@/src/lib/caddy-build";
import { describeModuleConflicts } from "@/src/lib/caddy-build-conflicts";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { CADDY_MODULES } from "@/src/lib/caddy-modules";
import { getCaddyBuildSettings, saveCaddyBuildSettings } from "@/src/lib/settings";

// Fixed at build time.
const AVAILABLE = CADDY_MODULES.map((m) => ({
  id: m.id,
  name: m.name,
  modulePath: m.modulePath,
  description: m.description,
  category: m.category,
  features: m.features,
}));

/** GET /api/v1/caddy/modules - with the catalog, since module ids are what PUT expects. */
export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    const [settings, diff] = await Promise.all([getCaddyBuildSettings(), getCaddyBuildDiff()]);
    return NextResponse.json({
      available: AVAILABLE,
      selection: {
        modules: settings?.modules ?? {},
        customModules: settings?.customModules ?? [],
      },
      diff,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * PUT /api/v1/caddy/modules - as Settings: the selection is desired state, so an agent that builds
 * its own image starts rebuilding on save.
 */
export async function PUT(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    const body = await request.json();
    const settings = sanitizeCaddyBuildSettings({
      modules: body?.modules,
      customModules: body?.customModules,
    });

    // As in Settings, or disabling an in-use module would silently drop that feature's handlers.
    const conflict = await describeModuleConflicts(settings);
    if (conflict) {
      return NextResponse.json({ error: conflict }, { status: 409 });
    }

    await saveCaddyBuildSettings(settings);

    // Before the push: a Caddy the rebuild recreates resumes its autosave, which must not name a
    // module the new binary lacks.
    await applyCaddyConfig();
    await pushDesiredState();

    return NextResponse.json({ selection: settings, diff: await getCaddyBuildDiff() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
