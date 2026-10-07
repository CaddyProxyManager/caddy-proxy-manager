import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { listCertificates, createCertificate } from "@/src/lib/models/certificates";
import { toCertificateApiResponse } from "@/src/lib/certificates/api";
import { createCertificateFromAgentFiles } from "@/src/lib/models/certificate-files";

const PRIVATE_RESPONSE_INIT = { headers: { "Cache-Control": "no-store" } };

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const certs = await listCertificates();
    return NextResponse.json(certs.map(toCertificateApiResponse), PRIVATE_RESPONSE_INIT);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const body = await request.json();
    // Read from the agent before anything is stored; see models/certificate-files.ts.
    const cert =
      body?.source === "agent-file"
        ? await createCertificateFromAgentFiles(
            {
              name: String(body.name ?? ""),
              agentRowId: Number(body.sourceAgentId),
              certPath: String(body.sourceCertPath ?? ""),
              keyPath: String(body.sourceKeyPath ?? ""),
            },
            userId,
          )
        : await createCertificate(body, userId);
    return NextResponse.json(toCertificateApiResponse(cert), {
      status: 201,
      headers: PRIVATE_RESPONSE_INIT.headers,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
