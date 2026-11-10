import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getWafPreset } from "@/src/lib/models/waf-presets";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const preset = await getWafPreset(Number(id));
    if (!preset) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(preset);
  },
);

export const PUT = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    for (const key of ["name", "description", "directives"] as const) {
      if (body?.[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
        return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
      }
    }
    const preset = await submitOrApply(apiSubmitter(caller), {
      kind: "wafPresetUpdate",
      payload: { id: Number(id), input: body },
    });
    return NextResponse.json(preset);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    await submitOrApply(apiSubmitter(caller), {
      kind: "wafPresetDelete",
      payload: { id: Number(id) },
    });
    return NextResponse.json({ ok: true });
  },
);
