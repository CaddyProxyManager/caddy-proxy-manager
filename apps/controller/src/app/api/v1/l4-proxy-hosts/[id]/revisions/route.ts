import { type NextRequest, NextResponse } from "next/server";
import { resolveL4ProxyHostId } from "@/src/lib/models/l4-proxy-hosts";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { countHostRevisions, listHostRevisions } from "@/src/lib/host-history";

/** Newest first, without the stored rows; GraphQL's hostRevision answers one in full. */
export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const hostId = await resolveL4ProxyHostId(id);
    if (hostId === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const search = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(search.get("limit") ?? 20) || 20, 1), 200);
    const offset = Math.max(Number(search.get("offset") ?? 0) || 0, 0);
    const [items, total] = await Promise.all([
      listHostRevisions("l4", hostId, limit, offset),
      countHostRevisions("l4", hostId),
    ]);
    return NextResponse.json({ items, total });
  },
);
