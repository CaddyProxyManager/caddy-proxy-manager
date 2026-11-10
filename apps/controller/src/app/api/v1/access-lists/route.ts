import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { listAccessLists } from "@/src/lib/models/access-lists";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const lists = await listAccessLists();
  return NextResponse.json(lists);
});

export const POST = apiRoute(async (request: NextRequest) => {
  const caller = await requireApiUser(request);
  const body = await request.json();
  const list = await submitOrApply(apiSubmitter(caller), {
    kind: "accessListCreate",
    payload: { input: body },
  });
  return NextResponse.json(list, { status: 201 });
});
