import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { removeRoleFromCertificate } from "@/src/lib/models/mtls-roles";

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string; certId: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id, certId } = await params;
    await removeRoleFromCertificate(Number(id), Number(certId), userId);
    return NextResponse.json({ ok: true });
  },
);
