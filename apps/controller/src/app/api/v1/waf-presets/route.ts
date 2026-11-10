import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listWafPresets } from "@/src/lib/models/waf-presets";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  return NextResponse.json(await listWafPresets());
});

export const POST = apiRoute(async (request: NextRequest) => {
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
});
