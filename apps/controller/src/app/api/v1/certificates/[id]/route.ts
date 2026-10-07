import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import {
  getCertificate,
  updateCertificate,
  deleteCertificate,
} from "@/src/lib/models/certificates";
import { toCertificateApiResponse } from "@/src/lib/certificates/api";

const PRIVATE_RESPONSE_INIT = { headers: { "Cache-Control": "no-store" } };

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const cert = await getCertificate(Number(id));
    if (!cert) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(toCertificateApiResponse(cert), PRIVATE_RESPONSE_INIT);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const cert = await updateCertificate(Number(id), body, userId);
    return NextResponse.json(toCertificateApiResponse(cert), PRIVATE_RESPONSE_INIT);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    await deleteCertificate(Number(id), userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
