/**
 * No port means 3000 for `web` but 443 for a Tailscale-served https name. Pairing sends the secret
 * over this link, so a bare host means https unless local, and http to a public address is refused.
 */
import { describe, expect, it } from "bun:test";
import {
  ControllerAddressError,
  checkControllerTransport,
  normalizeControllerUrl,
  normalizePairingCode,
} from "../src/controller-url";

describe("a bare host means https unless it stays local", () => {
  it("assumes https and 443 for an address with neither", () => {
    expect(normalizeControllerUrl("10.0.0.5")).toBe("https://10.0.0.5:443");
    expect(normalizeControllerUrl("cpm.example.com")).toBe("https://cpm.example.com:443");
  });

  it("keeps a port the operator typed", () => {
    expect(normalizeControllerUrl("cpm.example.com:8443")).toBe("https://cpm.example.com:8443");
  });

  it("keeps http and 3000 for a single-label name", () => {
    // The bundled stack's compose service, or a MagicDNS short name on the same tailnet.
    expect(normalizeControllerUrl("web")).toBe("http://web:3000");
    expect(normalizeControllerUrl("cpm-controller")).toBe("http://cpm-controller:3000");
  });

  it("keeps http and 3000 for loopback", () => {
    expect(normalizeControllerUrl("localhost")).toBe("http://localhost:3000");
    expect(normalizeControllerUrl("127.0.0.1")).toBe("http://127.0.0.1:3000");
  });

  it("brackets an IPv6 literal and treats it like any other host", () => {
    expect(normalizeControllerUrl("[fd7a:115c:a1e0::1]")).toBe("https://[fd7a:115c:a1e0::1]:443");
    expect(normalizeControllerUrl("http://[fd7a:115c:a1e0::1]")).toBe(
      "http://[fd7a:115c:a1e0::1]:3000",
    );
  });
});

describe("an explicit http:// keeps meaning the controller's own port", () => {
  it("still means 3000 when only the http scheme was spelled out", () => {
    // `http://web` has always meant the compose default.
    expect(normalizeControllerUrl("http://web")).toBe("http://web:3000");
    expect(normalizeControllerUrl("http://10.0.0.5")).toBe("http://10.0.0.5:3000");
  });

  it("keeps an explicitly typed 80 on an http address", () => {
    expect(normalizeControllerUrl("http://10.0.0.5:80")).toBe("http://10.0.0.5:80");
  });

  it("keeps a typed 80 on a bare host that becomes https", () => {
    // Parsed as http first, which drops :80 as the default; https must not then substitute 443.
    expect(normalizeControllerUrl("cpm.example.com:80")).toBe("https://cpm.example.com:80");
  });
});

describe("an https address means whatever is terminating TLS, not the controller", () => {
  it("defaults to 443, because the controller never serves TLS itself", () => {
    // What `tailscale serve` publishes; 3000 would dial a port nothing listens on.
    expect(normalizeControllerUrl("https://cpm.tailnet-1234.ts.net")).toBe(
      "https://cpm.tailnet-1234.ts.net:443",
    );
  });

  it("keeps an explicitly typed 443 rather than discarding it", () => {
    // `new URL` drops a default port, so an explicit :443 must not fall through to 3000.
    expect(normalizeControllerUrl("https://cpm.tailnet-1234.ts.net:443")).toBe(
      "https://cpm.tailnet-1234.ts.net:443",
    );
  });

  it("keeps any other port it was given", () => {
    expect(normalizeControllerUrl("https://cpm.example.com:8443")).toBe(
      "https://cpm.example.com:8443",
    );
  });

  it("lets --port override the scheme's default", () => {
    expect(normalizeControllerUrl("https://cpm.tailnet-1234.ts.net", 3000)).toBe(
      "https://cpm.tailnet-1234.ts.net:3000",
    );
  });
});

describe("whether plain http may be dialled", () => {
  it("says nothing about https, loopback or a compose name", () => {
    expect(checkControllerTransport("https://203.0.113.10:443", false)).toBeNull();
    expect(checkControllerTransport("http://web:3000", false)).toBeNull();
    expect(checkControllerTransport("http://localhost:3000", false)).toBeNull();
  });

  it("allows a private address or a tailnet, with a warning", () => {
    for (const url of [
      "http://10.0.0.5:3000",
      "http://172.16.4.2:3000",
      "http://192.168.1.20:3000",
      "http://100.98.59.37:3000",
      "http://[fd7a:115c:a1e0::1]:3000",
      "http://cpm-controller.tailnet-1234.ts.net:3000",
      "http://nas.local:3000",
    ]) {
      expect(checkControllerTransport(url, false)).toContain("plain http");
    }
  });

  it("refuses a public address", () => {
    for (const url of [
      "http://203.0.113.10:3000",
      "http://cpm.example.com:3000",
      // Just outside 172.16/12 and 100.64/10.
      "http://172.32.0.1:3000",
      "http://100.128.0.1:3000",
    ]) {
      expect(() => checkControllerTransport(url, false)).toThrow(ControllerAddressError);
    }
  });

  it("allows a public address with a warning once the operator opts in", () => {
    expect(checkControllerTransport("http://cpm.example.com:3000", true)).toContain("plain http");
  });
});

describe("refusals", () => {
  it("rejects an empty address", () => {
    expect(() => normalizeControllerUrl("  ")).toThrow(ControllerAddressError);
  });

  it("rejects a pasted dashboard URL rather than trimming it", () => {
    // Dropping the path would send a pairing code somewhere the operator did not mean.
    expect(() => normalizeControllerUrl("https://cpm.example.com/settings")).toThrow(
      ControllerAddressError,
    );
  });

  it("rejects a scheme that is not http or https", () => {
    expect(() => normalizeControllerUrl("ssh://cpm.example.com")).toThrow(ControllerAddressError);
  });

  it("rejects a port outside the valid range", () => {
    expect(() => normalizeControllerUrl("10.0.0.5", 70000)).toThrow(ControllerAddressError);
  });
});

describe("pairing codes", () => {
  it("upper-cases and strips spaces", () => {
    expect(normalizePairingCode(" ab cdef ")).toBe("ABCDEF");
  });

  it("refuses anything that is not six letters", () => {
    expect(() => normalizePairingCode("ABC12F")).toThrow(ControllerAddressError);
  });
});
