import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";

export const POST = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const plugin = await submitOrApply(apiSubmitter(caller), {
      kind: "crsPluginUpdate",
      payload: { id: Number(id) },
    });
    return NextResponse.json(plugin);
  },
);
