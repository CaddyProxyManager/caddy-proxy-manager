import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getL4ProxyHost, resolveL4ProxyHostId } from "@/src/lib/models/l4-proxy-hosts";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const host = await getL4ProxyHost(hostId);
    if (!host) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(host);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json();
    const host = await submitOrApply(apiSubmitter(caller), {
      kind: "l4HostUpdate",
      payload: { id: hostId, input: body },
    });
    return NextResponse.json(host);
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
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await submitOrApply(apiSubmitter(caller), {
      kind: "l4HostDelete",
      payload: { id: hostId },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
