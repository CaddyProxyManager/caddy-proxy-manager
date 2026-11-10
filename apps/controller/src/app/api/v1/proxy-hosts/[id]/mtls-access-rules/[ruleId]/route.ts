import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getMtlsAccessRule } from "@/src/lib/models/mtls-access-rules";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string; ruleId: string }> }) => {
    await requireApiUser(request);
    const { ruleId } = await params;
    const rule = await getMtlsAccessRule(Number(ruleId));
    if (!rule) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(rule);
  },
);

export const PUT = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string; ruleId: string }> }) => {
    const caller = await requireApiUser(request);
    const { ruleId } = await params;
    const body = await request.json();
    const rule = await submitOrApply(apiSubmitter(caller), {
      kind: "mtlsRuleUpdate",
      payload: { id: Number(ruleId), input: body },
    });
    return NextResponse.json(rule);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string; ruleId: string }> }) => {
    const caller = await requireApiUser(request);
    const { ruleId } = await params;
    await submitOrApply(apiSubmitter(caller), {
      kind: "mtlsRuleDelete",
      payload: { id: Number(ruleId) },
    });
    return NextResponse.json({ ok: true });
  },
);
