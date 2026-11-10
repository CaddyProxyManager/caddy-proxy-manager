import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import {
  listIssuedClientCertificates,
  createIssuedClientCertificate,
} from "@/src/lib/models/issued-client-certificates";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const certs = await listIssuedClientCertificates();
  return NextResponse.json(certs);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const { userId } = await requireApiUser(request);
  const body = await request.json();
  const cert = await createIssuedClientCertificate(body, userId);
  return NextResponse.json(cert, { status: 201 });
});
