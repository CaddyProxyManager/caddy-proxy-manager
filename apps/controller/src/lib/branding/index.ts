/**
 * In the database, which every instance shares, not the per-host data volume. A `settings` blob,
 * not a registry entry: `resolveAllSettings` loads every registry key, dragging the image along.
 */

import { createHash } from "node:crypto";
import { DomainError, type DomainErrorParams, domainErrorMessage } from "../errors/domain-error";
import { clearSetting, getSetting, setSetting } from "../settings";

const BRANDING_KEY = "branding";

/** Before base64. Well under the 2 MB action body limit, so the operator gets this message. */
export const MAX_FAVICON_BYTES = 256 * 1024;

export type FaviconAsset = {
  /** Base64. */
  data: string;
  /** Sniffed, never the browser's claim - see sniffFaviconType. */
  type: string;
  /** The ETag, so a replaced icon invalidates the cached one at once. */
  hash: string;
};

export type BrandingSettings = { favicon: FaviconAsset | null };

export class FaviconValidationError extends DomainError {
  constructor(
    code: "faviconEmpty" | "faviconTooLarge" | "faviconNotImage",
    params: DomainErrorParams = {},
  ) {
    super(code, params, domainErrorMessage(code, params));
    this.name = "FaviconValidationError";
  }
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/**
 * `File.type` is attacker-controlled and this becomes the served `Content-Type`, so sniffing keeps
 * an "image" from being served as something the browser treats as a document.
 */
export function sniffFaviconType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // The cursor variant (02) is deliberately not accepted.
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";

  // SVG: the root element, after a prologue whose parts are optional, repeat and come in any
  // order, hence the loop. TextDecoder already strips a BOM.
  let head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024)).trimStart();

  for (;;) {
    const shortened = head
      .replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
      .replace(/^<!--[\s\S]*?-->\s*/, "")
      .replace(/^<!DOCTYPE[^>]*>\s*/i, "");
    if (shortened === head) break;
    head = shortened;
  }

  if (/^<svg[\s/>]/i.test(head)) return "image/svg+xml";

  return null;
}

/** Throws `FaviconValidationError` for what an operator can act on; anything else is a bug. */
export async function saveFavicon(file: File): Promise<FaviconAsset> {
  if (file.size === 0) throw new FaviconValidationError("faviconEmpty");
  if (file.size > MAX_FAVICON_BYTES) {
    throw new FaviconValidationError("faviconTooLarge", {
      size: Math.ceil(file.size / 1024),
      limit: MAX_FAVICON_BYTES / 1024,
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffFaviconType(bytes);
  if (!type) {
    throw new FaviconValidationError("faviconNotImage");
  }

  const buffer = Buffer.from(bytes);
  const favicon: FaviconAsset = {
    data: buffer.toString("base64"),
    type,
    hash: createHash("sha256").update(buffer).digest("hex").slice(0, 32),
  };

  await setSetting<BrandingSettings>(BRANDING_KEY, { favicon });
  return favicon;
}

export async function getFavicon(): Promise<FaviconAsset | null> {
  const branding = await getSetting<BrandingSettings>(BRANDING_KEY);
  return branding?.favicon ?? null;
}

export async function clearFavicon(): Promise<void> {
  await clearSetting(BRANDING_KEY);
}
