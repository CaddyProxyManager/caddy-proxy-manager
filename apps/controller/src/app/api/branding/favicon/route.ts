/**
 * Serves the uploaded favicon, or 404. Deliberately public (see the allowlist in src/proxy.ts):
 * login, portal and setup render before there is a session, and a favicon is not secret.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getFavicon } from "@/src/lib/branding";

export async function GET(request: NextRequest) {
  const favicon = await getFavicon();

  // No custom icon is the normal case, and the browser treats it exactly as it treats the missing
  // /favicon.ico this app has always had. Not cached, so setting one takes effect immediately.
  if (!favicon) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }

  const etag = `"${favicon.hash}"`;
  const headers: Record<string, string> = {
    "content-type": favicon.type,
    etag,
    // Revalidate every time: a stale favicon reads as "the upload did not work", and the ETag
    // makes the usual answer a bodiless 304.
    "cache-control": "no-cache, must-revalidate",
    "x-content-type-options": "nosniff",
    // An SVG opened directly is a document, and a document can carry script. This makes the
    // response inert whatever is inside it, which is what lets SVG be an accepted format at all.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(Buffer.from(favicon.data, "base64"), { headers });
}
