import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getL4ProxyHost, resolveL4ProxyHostId } from "@/src/lib/models/l4-proxy-hosts";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const host = await getL4ProxyHost(hostId);
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
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json();
    const host = await submitOrApply(apiSubmitter(caller), {
      kind: "l4HostUpdate",
      payload: { id: hostId, input: body },
    });
    return NextResponse.json(host);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await submitOrApply(apiSubmitter(caller), {
      kind: "l4HostDelete",
      payload: { id: hostId },
    });
    return NextResponse.json({ ok: true });
  },
);
