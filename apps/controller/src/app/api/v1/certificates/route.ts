import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { listCertificates, createCertificate } from "@/src/lib/models/certificates";
import { toCertificateApiResponse } from "@/src/lib/certificates/api";
import { createCertificateFromAgentFiles } from "@/src/lib/models/certificate-files";

const PRIVATE_RESPONSE_INIT = { headers: { "Cache-Control": "no-store" } };

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const certs = await listCertificates();
  return NextResponse.json(certs.map(toCertificateApiResponse), PRIVATE_RESPONSE_INIT);
});

export const POST = apiRoute(async (request: NextRequest) => {
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
});
