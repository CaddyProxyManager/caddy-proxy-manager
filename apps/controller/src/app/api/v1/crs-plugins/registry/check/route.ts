import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { runCrsRegistrySync } from "@/src/lib/waf/crs-plugins/sync";
import { installedCrsPluginRepositories, listCrsRegistry } from "@/src/lib/models/crs-plugins";

/** Re-reads every registry and checks each plugin, answering once the pass is done. */
export async function POST(request: NextRequest) {
  try {
    await requireApiUser(request);
    const state = await runCrsRegistrySync({
      extraRepositories: await installedCrsPluginRepositories(),
    });
    return NextResponse.json({
      checkedAt: state.checkedAt,
      error: state.error?.message ?? null,
      sources: state.sources,
      plugins: await listCrsRegistry(),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
