import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { bulkUpdateL4ProxyHosts, parseL4HostBulkRequest } from "@/src/lib/models/bulk-hosts";

/** Admin-only, as for proxy hosts. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiAdmin(request);
    const result = await bulkUpdateL4ProxyHosts(
      parseL4HostBulkRequest(await request.json().catch(() => null)),
      userId,
    );
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
