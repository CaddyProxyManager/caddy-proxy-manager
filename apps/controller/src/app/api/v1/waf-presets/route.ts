import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listWafPresets } from "@/src/lib/models/waf-presets";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    return NextResponse.json(await listWafPresets());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const caller = await requireApiUser(request);
    const body = await request.json();
    if (typeof body?.name !== "string" || typeof body?.directives !== "string") {
      return NextResponse.json({ error: "name and directives are required" }, { status: 400 });
    }
    const preset = await submitOrApply(apiSubmitter(caller), {
      kind: "wafPresetCreate",
      payload: { input: body },
    });
    return NextResponse.json(preset, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
