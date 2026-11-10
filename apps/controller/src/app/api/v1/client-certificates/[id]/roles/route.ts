import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { getCertificateRoles } from "@/src/lib/models/mtls-roles";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const roles = await getCertificateRoles(Number(id));
    return NextResponse.json(roles);
  },
);
