import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getAccessList } from "@/src/lib/models/access-lists";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const list = await getAccessList(Number(id));
    if (!list) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(list);
  },
);

export const PUT = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const list = await submitOrApply(apiSubmitter(caller), {
      kind: "accessListUpdate",
      payload: { id: Number(id), input: body },
    });
    return NextResponse.json(list);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const caller = await requireApiUser(request);
    const { id } = await params;
    await submitOrApply(apiSubmitter(caller), {
      kind: "accessListDelete",
      payload: { id: Number(id) },
    });
    return NextResponse.json({ ok: true });
  },
);
