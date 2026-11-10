import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import {
  getIssuedClientCertificate,
  revokeIssuedClientCertificate,
} from "@/src/lib/models/issued-client-certificates";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const cert = await getIssuedClientCertificate(Number(id));
    if (!cert) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(cert);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const cert = await revokeIssuedClientCertificate(Number(id), userId);
    return NextResponse.json(cert);
  },
);
