import { type NextRequest, NextResponse } from "next/server";
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

/** PUT /api/v1/caddy/modules - no rebuild until POST /api/caddy-build. */
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

    // As Settings does: a stale config would name a module the next rebuild cannot load.
    await applyCaddyConfig();

    return NextResponse.json({ selection: settings, diff: await getCaddyBuildDiff() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
