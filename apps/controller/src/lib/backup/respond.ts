import { NextResponse } from "next/server";

/** A backup as a download, named for when it was made. */
export function backupDownload(file: Buffer): NextResponse {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="cpm-backup-${stamp}.cpmbak"`,
      "Cache-Control": "no-store",
    },
  });
}
