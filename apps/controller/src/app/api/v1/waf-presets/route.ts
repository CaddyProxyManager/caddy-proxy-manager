import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { listWafPresets, createWafPreset } from "@/src/lib/models/waf-presets";

export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    return NextResponse.json(await listWafPresets());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiAdmin(request);
    const body = await request.json();
    if (typeof body?.name !== "string" || typeof body?.directives !== "string") {
      return NextResponse.json({ error: "name and directives are required" }, { status: 400 });
    }
    const preset = await createWafPreset(body, userId);
    return NextResponse.json(preset, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
