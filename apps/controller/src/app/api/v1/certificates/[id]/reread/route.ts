import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { rereadCertificateFile } from "@/src/lib/models/certificate-files";
import { toCertificateApiResponse } from "@/src/lib/certificates/api";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const cert = await rereadCertificateFile(Number(id), userId);
    return NextResponse.json(toCertificateApiResponse(cert), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
