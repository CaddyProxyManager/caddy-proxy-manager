import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { installCrsPlugin, listCrsPlugins, listCrsRegistry } from "@/src/lib/models/crs-plugins";

export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    return NextResponse.json(await listCrsPlugins());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiAdmin(request);
    const body = await request.json();
    if (typeof body?.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (body.registry !== undefined && typeof body.registry !== "string") {
      return NextResponse.json({ error: "registry must be a string" }, { status: 400 });
    }
    const name = body.name.trim();
    let registry: string | undefined = body.registry;
    if (!registry) {
      // Optional while only one registry lists the name.
      const listed = (await listCrsRegistry()).filter((entry) => entry.name === name);
      if (listed.length > 1) {
        return NextResponse.json(
          { error: "several registries list this name; say which with registry" },
          { status: 400 },
        );
      }
      registry = listed[0]?.registryId ?? "";
    }
    const plugin = await installCrsPlugin(registry, name, userId);
    return NextResponse.json(plugin, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
