import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { assignRoleToCertificate, getMtlsRole } from "@/src/lib/models/mtls-roles";

export const POST = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    if (!body.certificateId || typeof body.certificateId !== "number") {
      return NextResponse.json({ error: "certificateId is required" }, { status: 400 });
    }
    await assignRoleToCertificate(Number(id), body.certificateId, userId);
    const role = await getMtlsRole(Number(id));
    return NextResponse.json(role, { status: 201 });
  },
);
