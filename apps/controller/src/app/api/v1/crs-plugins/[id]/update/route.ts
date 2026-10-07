import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const plugin = await submitOrApply(apiSubmitter(caller), {
      kind: "crsPluginUpdate",
      payload: { id: Number(id) },
    });
    return NextResponse.json(plugin);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
