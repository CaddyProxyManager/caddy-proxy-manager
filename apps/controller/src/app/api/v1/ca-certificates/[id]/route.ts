import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import {
  getCaCertificate,
  updateCaCertificate,
  deleteCaCertificate,
} from "@/src/lib/models/ca-certificates";

export const GET = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireApiUser(request);
    const { id } = await params;
    const cert = await getCaCertificate(Number(id));
    if (!cert) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(cert);
  },
);

export const PUT = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const cert = await updateCaCertificate(Number(id), body, userId);
    return NextResponse.json(cert);
  },
);

export const DELETE = apiRoute(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    await deleteCaCertificate(Number(id), userId);
    return NextResponse.json({ ok: true });
  },
);
