import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { getMtlsRole, updateMtlsRole, deleteMtlsRole } from "@/src/lib/models/mtls-roles";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const role = await getMtlsRole(Number(id));
    if (!role) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(role);
  },
);

export const PUT = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const role = await updateMtlsRole(Number(id), body, userId);
    return NextResponse.json(role);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    await deleteMtlsRole(Number(id), userId);
    return NextResponse.json({ ok: true });
  },
);
