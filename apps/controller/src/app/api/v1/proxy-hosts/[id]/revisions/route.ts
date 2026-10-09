import { type NextRequest, NextResponse } from "next/server";
import { resolveProxyHostId } from "@/src/lib/models/proxy-hosts";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { countHostRevisions, listHostRevisions } from "@/src/lib/host-history";

/** Newest first, without the stored rows; GraphQL's hostRevision answers one in full. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const search = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(search.get("limit") ?? 20) || 20, 1), 200);
    const offset = Math.max(Number(search.get("offset") ?? 0) || 0, 0);
    const [items, total] = await Promise.all([
      listHostRevisions("http", hostId, limit, offset),
      countHostRevisions("http", hostId),
    ]);
    return NextResponse.json({ items, total });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
