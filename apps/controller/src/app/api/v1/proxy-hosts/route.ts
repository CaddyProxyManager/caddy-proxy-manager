import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const hosts = await listProxyHosts();
    return NextResponse.json(hosts);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const caller = await requireApiUser(request);
    const body = await request.json();
    const host = await submitOrApply(apiSubmitter(caller), {
      kind: "proxyHostCreate",
      payload: { input: body },
    });
    return NextResponse.json(host, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
