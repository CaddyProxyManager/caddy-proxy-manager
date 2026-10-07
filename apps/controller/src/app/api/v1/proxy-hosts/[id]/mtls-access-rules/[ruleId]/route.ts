import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { getMtlsAccessRule } from "@/src/lib/models/mtls-access-rules";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  try {
    await requireApiUser(request);
    const { ruleId } = await params;
    const rule = await getMtlsAccessRule(Number(ruleId));
    if (!rule) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(rule);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  try {
    const caller = await requireApiUser(request);
    const { ruleId } = await params;
    const body = await request.json();
    const rule = await submitOrApply(apiSubmitter(caller), {
      kind: "mtlsRuleUpdate",
      payload: { id: Number(ruleId), input: body },
    });
    return NextResponse.json(rule);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  try {
    const caller = await requireApiUser(request);
    const { ruleId } = await params;
    await submitOrApply(apiSubmitter(caller), {
      kind: "mtlsRuleDelete",
      payload: { id: Number(ruleId) },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
