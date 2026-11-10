import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getProxyHost, resolveProxyHostId } from "@/src/lib/models/proxy-hosts";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const host = await getProxyHost(hostId);
    if (!host) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(host);
  },
);

export const PUT = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json();
    const host = await submitOrApply(apiSubmitter(caller), {
      kind: "proxyHostUpdate",
      payload: { id: hostId, input: body },
    });
    return NextResponse.json(host);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await submitOrApply(apiSubmitter(caller), {
      kind: "proxyHostDelete",
      payload: { id: hostId },
    });
    return NextResponse.json({ ok: true });
  },
);
