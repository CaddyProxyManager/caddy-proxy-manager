import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { bulkUpdateProxyHosts, parseProxyHostBulkRequest } from "@/src/lib/models/bulk-hosts";

/** Admin-only: an API token carries no per-host grants to check each id against. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiAdmin(request);
    const result = await bulkUpdateProxyHosts(
      parseProxyHostBulkRequest(await request.json().catch(() => null)),
      userId,
    );
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
