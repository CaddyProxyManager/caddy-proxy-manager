import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { countHostRevisions, listHostRevisions } from "@/src/lib/host-history";

/** Newest first, without the stored rows; GraphQL's hostRevision answers one in full. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiAdmin(request);
    const { id } = await params;
    const search = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(search.get("limit") ?? 20) || 20, 1), 200);
    const offset = Math.max(Number(search.get("offset") ?? 0) || 0, 0);
    const [items, total] = await Promise.all([
      listHostRevisions("l4", Number(id), limit, offset),
      countHostRevisions("l4", Number(id)),
    ]);
    return NextResponse.json({ items, total });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
