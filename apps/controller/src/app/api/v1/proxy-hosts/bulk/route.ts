import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { parseProxyHostBulkRequest } from "@/src/lib/models/bulk-hosts";

/** Admin-only: an API token carries no per-host grants to check each id against. */
export const POST = apiRoute(async (request: NextRequest) => {
  const caller = await requireApiUser(request);
  const count = await submitOrApply(apiSubmitter(caller), {
    kind: "proxyHostBulk",
    payload: parseProxyHostBulkRequest(await request.json().catch(() => null)),
  });
  return NextResponse.json({ count });
});
