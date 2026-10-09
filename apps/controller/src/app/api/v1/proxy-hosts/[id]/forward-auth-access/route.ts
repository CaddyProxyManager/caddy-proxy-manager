import { type NextRequest, NextResponse } from "next/server";
import { resolveProxyHostId } from "@/src/lib/models/proxy-hosts";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getForwardAuthAccessForHost } from "@/src/lib/models/forward-auth";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const access = await getForwardAuthAccessForHost(hostId);
    return NextResponse.json(access);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json();
    const access = await submitOrApply(apiSubmitter(caller), {
      kind: "forwardAuthAccess",
      payload: {
        hostId: hostId,
        access: { userIds: body.userIds, groupIds: body.groupIds },
      },
    });
    return NextResponse.json(access);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
