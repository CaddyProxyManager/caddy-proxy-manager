/** A user agent as a person would name the device: "Firefox on Windows". */

export type DeviceWords = {
  unknown: string;
  browser: string;
  onOs: (browser: string, os: string) => string;
};

/** Only the prose words are passed in; browser and OS names are the same in every language. */
export function describeDevice(ua: string | null, words: DeviceWords): string {
  if (!ua) return words.unknown;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : words.browser;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? words.onOs(browser, os) : browser;
}
