/**
 * Favicon type sniffing: the stored type becomes the route's Content-Type, and the browser's claim
 * about an upload is attacker-controlled.
 */
import { describe, expect, it } from 'bun:test';
import { MAX_FAVICON_BYTES, sniffFaviconType } from '@/src/lib/branding';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new TextEncoder().encode('GIF89a....');

function webp(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  return bytes;
}

describe('favicon type sniffing', () => {
  it('recognises the raster formats by their magic bytes', () => {
    expect(sniffFaviconType(PNG)).toBe('image/png');
    expect(sniffFaviconType(ICO)).toBe('image/x-icon');
    expect(sniffFaviconType(JPEG)).toBe('image/jpeg');
    expect(sniffFaviconType(GIF)).toBe('image/gif');
    expect(sniffFaviconType(webp())).toBe('image/webp');
  });

  it('recognises SVG through a declaration, a doctype and leading whitespace', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(sniffFaviconType(encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'image/svg+xml',
    );
    expect(sniffFaviconType(encode('<?xml version="1.0"?><svg/>'))).toBe('image/svg+xml');
    expect(sniffFaviconType(encode('\n\n  <svg />'))).toBe('image/svg+xml');
    expect(sniffFaviconType(encode('\ufeff<svg />'))).toBe('image/svg+xml');
  });

  it('refuses a file that is not an image', () => {
    // Claimed as an image, bytes of a document: refused on its bytes.
    expect(
      sniffFaviconType(new TextEncoder().encode('<html><script>alert(1)</script>')),
    ).toBeNull();
    expect(sniffFaviconType(new TextEncoder().encode('#!/bin/sh\nrm -rf /'))).toBeNull();
    expect(sniffFaviconType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(sniffFaviconType(new Uint8Array(0))).toBeNull();
  });

  it('does not mistake a cursor for an icon', () => {
    // .cur shares the .ico container and differs only in the type field.
    expect(sniffFaviconType(new Uint8Array([0x00, 0x00, 0x02, 0x00, 0x01, 0x00]))).toBeNull();
  });

  it('does not accept a RIFF container that is not WebP', () => {
    const wav = new Uint8Array(16);
    wav.set(new TextEncoder().encode('RIFF'), 0);
    wav.set(new TextEncoder().encode('WAVE'), 8);
    expect(sniffFaviconType(wav)).toBeNull();
  });

  it('caps the upload well under the server action body limit', () => {
    // Below next.config.mjs's 2 MB action limit, or the framework rejects it with no message.
    expect(MAX_FAVICON_BYTES).toBeLessThan(2 * 1024 * 1024);
  });
});
