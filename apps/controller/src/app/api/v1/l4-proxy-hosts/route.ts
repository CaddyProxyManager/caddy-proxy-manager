import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listL4ProxyHosts } from "@/src/lib/models/l4-proxy-hosts";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const hosts = await listL4ProxyHosts();
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
      kind: "l4HostCreate",
      payload: { input: body },
    });
    return NextResponse.json(host, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
