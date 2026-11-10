import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listL4ProxyHosts } from "@/src/lib/models/l4-proxy-hosts";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const hosts = await listL4ProxyHosts();
  return NextResponse.json(hosts);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const caller = await requireApiUser(request);
  const body = await request.json();
  const host = await submitOrApply(apiSubmitter(caller), {
    kind: "l4HostCreate",
    payload: { input: body },
  });
  return NextResponse.json(host, { status: 201 });
});
