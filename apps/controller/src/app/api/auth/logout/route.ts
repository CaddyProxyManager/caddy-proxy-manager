import { type NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/src/lib/auth-server";
import { checkSameOrigin } from "@/src/lib/auth";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  await (await getAuth()).api.signOut({ headers: await headers() });
  // Relative, so the browser stays on the address it posted from: CSP form-action 'self' also
  // governs this redirect, and the Public URL may be another of this instance's addresses.
  return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
}
