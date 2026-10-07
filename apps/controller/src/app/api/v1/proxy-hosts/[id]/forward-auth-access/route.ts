import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getForwardAuthAccessForHost } from "@/src/lib/models/forward-auth";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const access = await getForwardAuthAccessForHost(Number(id));
    return NextResponse.json(access);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const access = await submitOrApply(apiSubmitter(caller), {
      kind: "forwardAuthAccess",
      payload: {
        hostId: Number(id),
        access: { userIds: body.userIds, groupIds: body.groupIds },
      },
    });
    return NextResponse.json(access);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
