import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { listCaCertificates, createCaCertificate } from "@/src/lib/models/ca-certificates";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const certs = await listCaCertificates();
    return NextResponse.json(certs);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const body = await request.json();
    const cert = await createCaCertificate(body, userId);
    return NextResponse.json(cert, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
