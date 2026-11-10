import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { getL4PortsDiff, getL4PortsStatus, applyL4Ports } from "@/src/lib/l4/ports";

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const [diff, status] = await Promise.all([getL4PortsDiff(), getL4PortsStatus()]);
  return NextResponse.json({ diff, status });
});

export const POST = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  const status = await applyL4Ports();
  return NextResponse.json({ status });
});
