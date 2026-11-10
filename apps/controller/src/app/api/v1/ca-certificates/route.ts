import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { listCaCertificates, createCaCertificate } from "@/src/lib/models/ca-certificates";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const certs = await listCaCertificates();
  return NextResponse.json(certs);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const { userId } = await requireApiUser(request);
  const body = await request.json();
  const cert = await createCaCertificate(body, userId);
  return NextResponse.json(cert, { status: 201 });
});
