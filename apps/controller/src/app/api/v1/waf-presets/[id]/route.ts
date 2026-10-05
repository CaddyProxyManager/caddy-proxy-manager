import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { getWafPreset, updateWafPreset, deleteWafPreset } from "@/src/lib/models/waf-presets";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiAdmin(request);
    const { id } = await params;
    const preset = await getWafPreset(Number(id));
    if (!preset) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(preset);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiAdmin(request);
    const { id } = await params;
    const body = await request.json();
    for (const key of ["name", "description", "directives"] as const) {
      if (body?.[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
        return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
      }
    }
    const preset = await updateWafPreset(Number(id), body, userId);
    return NextResponse.json(preset);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await requireApiAdmin(request);
    const { id } = await params;
    await deleteWafPreset(Number(id), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
