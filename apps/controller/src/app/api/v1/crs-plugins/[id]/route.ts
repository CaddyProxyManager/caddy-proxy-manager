import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getCrsPlugin } from "@/src/lib/models/crs-plugins";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const plugin = await getCrsPlugin(Number(id));
    if (!plugin) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(plugin);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Only the -config file is the operator's to change; the rest is the release as fetched. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    if (body?.config !== null && typeof body?.config !== "string") {
      return NextResponse.json({ error: "config must be a string or null" }, { status: 400 });
    }
    const plugin = await submitOrApply(apiSubmitter(caller), {
      kind: "crsPluginConfig",
      payload: { id: Number(id), config: body.config },
    });
    return NextResponse.json(plugin);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    await submitOrApply(apiSubmitter(caller), {
      kind: "crsPluginUninstall",
      payload: { id: Number(id) },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
