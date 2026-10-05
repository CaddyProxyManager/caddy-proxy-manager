/**
 * A user agent's family, worked out once at ingest so it can be filtered and grouped in SQL. Client
 * safe: the page labels raw user agents with the same rules. Order matters, since most browsers
 * claim to be several others.
 */

const FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/Googlebot/i, "Googlebot"],
  [/bingbot/i, "Bingbot"],
  [/DuckDuckBot/i, "DuckDuckBot"],
  [/YandexBot/i, "YandexBot"],
  [/Applebot/i, "Applebot"],
  [/curl\//i, "curl"],
  [/Wget/i, "Wget"],
  [/python-requests|python-urllib|aiohttp|Python\//i, "Python"],
  [/Go-http-client/i, "Go"],
  [/okhttp/i, "OkHttp"],
  [/node-fetch|undici|axios/i, "Node.js"],
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/Chrome\/|CriOS/, "Chrome"],
  [/Safari\//, "Safari"],
  [/bot|crawler|spider|scanner/i, "Other bot"],
];

/** `""` for no user agent at all; `Other` for one that matches no family. */
export function userAgentFamily(userAgent: string): string {
  if (!userAgent.trim()) return "";
  for (const [pattern, family] of FAMILIES) {
    if (pattern.test(userAgent)) return family;
  }
  return "Other";
}
