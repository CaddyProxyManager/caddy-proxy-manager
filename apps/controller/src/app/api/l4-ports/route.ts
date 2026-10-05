import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { getL4PortsDiff, getL4PortsStatus, applyL4Ports } from "@/src/lib/l4/ports";

export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    const [diff, status] = await Promise.all([getL4PortsDiff(), getL4PortsStatus()]);
    return NextResponse.json({ diff, status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    const status = await applyL4Ports();
    return NextResponse.json({ status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
