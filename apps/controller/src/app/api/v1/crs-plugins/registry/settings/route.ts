import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import {
  type CrsRegistrySettingsInput,
  getCrsRegistrySettings,
  saveCrsRegistrySettings,
} from "@/src/lib/waf/crs-plugins/settings";
import { runCrsRegistrySync } from "@/src/lib/waf/crs-plugins/sync";
import { installedCrsPluginRepositories } from "@/src/lib/models/crs-plugins";

export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    return NextResponse.json(await getCrsRegistrySettings());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Fields left out keep their value; the token is write-only. */
export async function PUT(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    const body = await request.json();
    const input: CrsRegistrySettingsInput = {};
    if (body?.registries !== undefined) {
      if (
        !Array.isArray(body.registries) ||
        body.registries.some(
          (r: unknown) =>
            typeof (r as { name?: unknown })?.name !== "string" ||
            typeof (r as { url?: unknown })?.url !== "string",
        )
      ) {
        return NextResponse.json(
          { error: "registries must be a list of { id?, name, url }" },
          { status: 400 },
        );
      }
      input.registries = body.registries;
    }
    if (body?.refreshIntervalHours !== undefined) {
      if (typeof body.refreshIntervalHours !== "number") {
        return NextResponse.json(
          { error: "refreshIntervalHours must be a number" },
          { status: 400 },
        );
      }
      input.refreshIntervalHours = body.refreshIntervalHours;
    }
    if (body?.githubToken !== undefined) {
      if (typeof body.githubToken !== "string") {
        return NextResponse.json({ error: "githubToken must be a string" }, { status: 400 });
      }
      input.githubToken = body.githubToken;
    }
    if (await saveCrsRegistrySettings(input)) {
      void installedCrsPluginRepositories()
        .then((extraRepositories) => runCrsRegistrySync({ extraRepositories }))
        .catch((error: unknown) => console.error("[crs-plugins] registry check failed:", error));
    }
    return NextResponse.json(await getCrsRegistrySettings());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
