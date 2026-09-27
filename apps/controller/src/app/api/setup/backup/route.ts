import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { NextRequest } from "next/server";
import { auth } from "@/src/lib/auth";
import { getMigrationSource } from "@/src/lib/setup";

/**
 * GET /api/setup/backup - the SQLite file this deployment migrated from. The path comes from the
 * database, never the request, or this would be an arbitrary file read.
 */
export async function GET(request: NextRequest) {
  const session = await auth(request);
  if (session?.user?.role !== "admin") {
    return new Response("Not found", { status: 404 });
  }

  const path = await getMigrationSource();
  if (!path || !existsSync(path)) {
    return new Response("No migrated database is available to download.", { status: 404 });
  }

  // node:stream's toWeb produces a type Response does not accept.
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": `attachment; filename="${basename(path)}"`,
      // A database dump; nothing should cache a copy.
      "Cache-Control": "no-store",
    },
  });
}
