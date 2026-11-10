import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import {
  getCertificate,
  updateCertificate,
  deleteCertificate,
} from "@/src/lib/models/certificates";
import { toCertificateApiResponse } from "@/src/lib/certificates/api";

const PRIVATE_RESPONSE_INIT = { headers: { "Cache-Control": "no-store" } };

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const cert = await getCertificate(Number(id));
    if (!cert) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(toCertificateApiResponse(cert), PRIVATE_RESPONSE_INIT);
  },
);

export const PUT = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const cert = await updateCertificate(Number(id), body, userId);
    return NextResponse.json(toCertificateApiResponse(cert), PRIVATE_RESPONSE_INIT);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    await deleteCertificate(Number(id), userId);
    return NextResponse.json({ ok: true });
  },
);
