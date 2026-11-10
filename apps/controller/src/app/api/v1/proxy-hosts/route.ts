import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const hosts = await listProxyHosts();
  return NextResponse.json(hosts);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const caller = await requireApiUser(request);
  const body = await request.json();
  const host = await submitOrApply(apiSubmitter(caller), {
    kind: "proxyHostCreate",
    payload: { input: body },
  });
  return NextResponse.json(host, { status: 201 });
});
