import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { listMtlsRoles, createMtlsRole } from "@/src/lib/models/mtls-roles";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const roles = await listMtlsRoles();
    return NextResponse.json(roles);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const body = await request.json();
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const role = await createMtlsRole(body, userId);
    return NextResponse.json(role, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
