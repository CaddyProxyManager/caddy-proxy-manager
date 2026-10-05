import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { updateCrsPlugin } from "@/src/lib/models/crs-plugins";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiAdmin(request);
    const { id } = await params;
    return NextResponse.json(await updateCrsPlugin(Number(id), userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
