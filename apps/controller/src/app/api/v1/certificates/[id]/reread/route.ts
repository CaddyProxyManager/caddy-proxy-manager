import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { rereadCertificateFile } from "@/src/lib/models/certificate-files";
import { toCertificateApiResponse } from "@/src/lib/certificates/api";

export const POST = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const cert = await rereadCertificateFile(Number(id), userId);
    return NextResponse.json(toCertificateApiResponse(cert), {
      headers: { "Cache-Control": "no-store" },
    });
  },
);
