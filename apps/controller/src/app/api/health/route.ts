import { NextResponse } from "next/server";
import { MAX_NONCE_LENGTH, PROBE_PARAM, signProbe } from "@/src/lib/reachability-probe";

/**
 * Docker health check, and the reachability probe: `?probe=<nonce>` signs the nonce with a
 * probe-only key to prove the request arrived here (see reachability-probe.ts). Public, since an
 * HMAC of the caller's own nonce under a key nothing else trusts reveals nothing.
 */
export async function GET(request: Request) {
  const nonce = new URL(request.url).searchParams.get(PROBE_PARAM);

  // Bounded before it is signed, so this cannot be used to sign arbitrary content.
  if (nonce && nonce.length <= MAX_NONCE_LENGTH) {
    return NextResponse.json({ status: "ok", probe: signProbe(nonce) }, { status: 200 });
  }

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
