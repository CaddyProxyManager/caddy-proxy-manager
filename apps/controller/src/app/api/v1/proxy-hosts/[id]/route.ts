import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getProxyHost } from "@/src/lib/models/proxy-hosts";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const host = await getProxyHost(Number(id));
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
    const body = await request.json();
    const host = await submitOrApply(apiSubmitter(caller), {
      kind: "proxyHostUpdate",
      payload: { id: Number(id), input: body },
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
    await submitOrApply(apiSubmitter(caller), {
      kind: "proxyHostDelete",
      payload: { id: Number(id) },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
