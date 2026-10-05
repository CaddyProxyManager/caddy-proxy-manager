import { existsSync } from "node:fs";
import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { geoipDatabasePath, geoipEnabled } from "@/src/lib/agent/geoip";

export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    // Absent while GeoIP is off, or a stale file would offer country matching it stops emitting.
    const enabled = await geoipEnabled();
    return NextResponse.json({
      // So the UI can tell "off" from "on but not downloaded yet": the fixes differ.
      enabled,
      country: enabled && existsSync(geoipDatabasePath("GeoLite2-Country")),
      asn: enabled && existsSync(geoipDatabasePath("GeoLite2-ASN")),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
