import { describe, expect, it } from "bun:test";
import { STORAGE_NAME, parseCertificateListing } from "../src/certificates";

// Self-signed for app.example.com and www.example.com; the content is irrelevant, only its shape.
const PEM = `-----BEGIN CERTIFICATE-----
MIIDYTCCAkmgAwIBAgIQehUXEXPrlh28SKkrwlIZbjANBgkqhkiG9w0BAQsFADA8
MRgwFgYDVQQDEw9hcHAuZXhhbXBsZS5jb20xIDAeBgNVBAoTF0NhZGR5IFByb3h5
IE1hbmFnZXIgRTJFMB4XDTI2MDkyNjE2MDAzOVoXDTI2MTIyNTE3MDAzOVowPDEY
MBYGA1UEAxMPYXBwLmV4YW1wbGUuY29tMSAwHgYDVQQKExdDYWRkeSBQcm94eSBN
YW5hZ2VyIEUyRTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMbp6X07
zvG+N4BYAFAWkyk02wxdBnbpxdjE5Mog21Qwvrjkq1B28tc9fHMTBnzARp4n7JjI
H4wwpkzW3czXXt22/Vhhsd1c6z0WtHn4i6eccSi+wb8qSjBA5xkKWfl2W7zdYKS9
kIaEbISffqMvRMva7iNcLu3szQH6bCLD5Mdq1VeYCDNDFPdyBxVdeNF0hqtbwvOW
VXFjsV4bRo+D++masm9QW6B51Vi90eTt6okvC0ZrkT1KQu9FfLq6vvOGvegG2WzT
s2bi6Hq/DdeMctEbCDUHzkBPjfixvH1rctEtSrz9D+LMuwEjwcTcqxKzcJqJ0ArW
LG4cbkMrtR6jFPUCAwEAAaNfMF0wCQYDVR0TBAIwADAOBgNVHQ8BAf8EBAMCBaAw
EwYDVR0lBAwwCgYIKwYBBQUHAwEwKwYDVR0RBCQwIoIPYXBwLmV4YW1wbGUuY29t
gg93d3cuZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQADggEBAGhjQvqknyJjYTFR
R5gcrFJUWdwXvw23+Zs/N+wAJgQsEKORWTkoNz5COG+OkEO1szUCFrIMLYOdUwpp
dDSMJhJH6r85FyN2d77iIsbD8be/ca0WxCt1ghonfviP+kxm4K/sk9U1gmpY5pfa
E9dfrlSGJu0imYfF15tRbqEdKlwtLWfC4yAUHtUQosJhMH7uNqvE2DutZMW15kDR
rJYqt6ZoWXzM5p1PJZ6JsKj7veOte/9IktZIrsm7cmYlglILDkRo5t16u/0w+LVr
AxR6gc+icu6uqlCieh7lj2YzRdgZMnIWM8NHWebaRgJu6KDTXbt4Jig6vAHpvyni
UeXdHTI=
-----END CERTIFICATE-----`;

describe("parseCertificateListing", () => {
  it("reads each certificate's names and dates, and skips what isn't one", () => {
    const listing = [
      "noise before the first separator",
      "@@cpm-cert@@ acme-v02.api.letsencrypt.org-directory/app.example.com/app.example.com.crt",
      PEM,
      "@@cpm-cert@@ acme-v02.api.letsencrypt.org-directory/broken/broken.crt",
      "not a certificate",
      "@@cpm-cert@@ ../escape/escape.crt",
      PEM,
    ].join("\n");
    const found = parseCertificateListing(listing);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      issuerKey: "acme-v02.api.letsencrypt.org-directory",
      name: "app.example.com",
      names: ["app.example.com", "www.example.com"],
    });
    expect(Date.parse(found[0].notAfter)).toBeGreaterThan(Date.parse(found[0].notBefore));
  });
});

describe("STORAGE_NAME", () => {
  it("allows storage names, wildcards included, and no traversal", () => {
    for (const ok of [
      "app.example.com",
      "wildcard_.example.com",
      "*.example.com",
      "acme.zerossl.com-v2-dv90",
    ]) {
      expect(STORAGE_NAME.test(ok)).toBe(true);
    }
    for (const bad of ["..", "../etc", "a/b", "", ".hidden", "a b"]) {
      expect(STORAGE_NAME.test(bad)).toBe(false);
    }
  });
});
