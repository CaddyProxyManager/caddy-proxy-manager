/**
 * Serves the uploaded favicon, or the default logo. Deliberately public (see the allowlist in src/proxy.ts):
 * login, portal and setup render before there is a session, and a favicon is not secret.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getFavicon } from "@/src/lib/branding";
import { DEFAULT_FAVICON_SVG } from "@/src/lib/branding/default-favicon";

// An SVG opened directly is a document, and a document can carry script. This makes the
// response inert whatever is inside it, which is what lets SVG be an accepted format at all.
const INERT = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export async function GET(request: NextRequest) {
  const favicon = await getFavicon();

  // The normal case. Not cached for long, so an upload takes effect at once.
  if (!favicon) {
    return new NextResponse(DEFAULT_FAVICON_SVG, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "no-cache, must-revalidate",
        "x-content-type-options": "nosniff",
        "content-security-policy": INERT,
      },
    });
  }

  const etag = `"${favicon.hash}"`;
  const headers: Record<string, string> = {
    "content-type": favicon.type,
    etag,
    // Revalidate every time: a stale favicon reads as "the upload did not work", and the ETag
    // makes the usual answer a bodiless 304.
    "cache-control": "no-cache, must-revalidate",
    "x-content-type-options": "nosniff",
    "content-security-policy": INERT,
  };

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(Buffer.from(favicon.data, "base64"), { headers });
}
