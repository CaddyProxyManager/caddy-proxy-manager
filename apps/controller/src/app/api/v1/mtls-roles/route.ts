import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { listMtlsRoles, createMtlsRole } from "@/src/lib/models/mtls-roles";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const roles = await listMtlsRoles();
  return NextResponse.json(roles);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const { userId } = await requireApiUser(request);
  const body = await request.json();
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const role = await createMtlsRole(body, userId);
  return NextResponse.json(role, { status: 201 });
});
