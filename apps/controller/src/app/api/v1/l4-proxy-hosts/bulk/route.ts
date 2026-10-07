import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { apiSubmitter, submitOrApply } from "@/src/lib/approvals";
import { parseL4HostBulkRequest } from "@/src/lib/models/bulk-hosts";

/** Admin-only, as for proxy hosts. */
export async function POST(request: NextRequest) {
  try {
    const caller = await requireApiUser(request);
    const count = await submitOrApply(apiSubmitter(caller), {
      kind: "l4HostBulk",
      payload: parseL4HostBulkRequest(await request.json().catch(() => null)),
    });
    return NextResponse.json({ count });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
