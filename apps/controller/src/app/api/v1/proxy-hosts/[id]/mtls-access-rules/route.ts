import { type NextRequest, NextResponse } from "next/server";
import { resolveProxyHostId } from "@/src/lib/models/proxy-hosts";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listMtlsAccessRules } from "@/src/lib/models/mtls-access-rules";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const rules = await listMtlsAccessRules(hostId);
    return NextResponse.json(rules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const caller = await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json();
    if (!body.pathPattern || typeof body.pathPattern !== "string" || !body.pathPattern.trim()) {
      return NextResponse.json({ error: "pathPattern is required" }, { status: 400 });
    }
    const rule = await submitOrApply(apiSubmitter(caller), {
      kind: "mtlsRuleCreate",
      payload: { input: { ...body, proxyHostId: hostId } },
    });
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
