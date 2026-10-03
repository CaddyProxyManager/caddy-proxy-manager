/**
 * Certificates read from the operator's directory. The controller names the paths, so everything
 * here is about a path it names never reading anything else, and a key never leaving unasked.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CertificateFileResult,
  type CertificateFileSource,
  isValidCertificateFilePath,
} from "@cpm/shared";
import {
  CertificateFilePoller,
  certificatePair,
  parseCertificateFileListing,
  parseCertificateFileRead,
  readCertificateFiles,
  withoutKnownPem,
} from "../src/certificate-files";
import { type AgentConfig, loadConfig } from "../src/config";
import { DockerHost } from "../src/docker";
import { CERT_A, CERT_B, KEY_A, KEY_B } from "./helpers/cert-fixtures";

const SEP = "@@cpm-certfile@@";
const NUL = String.fromCharCode(0);

let dir: string;
let config: AgentConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-cert-files-"));
  process.env.DATA_DIR = dir;
  process.env.COMPOSE_DIR = dir;
  process.env.CERT_FILES_HOST_DIR = "/srv/certs";
  config = loadConfig();
});

afterEach(() => {
  delete process.env.CERT_FILES_HOST_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** Answers every read with `files` keyed by path, as the read script prints them. */
function fakeDocker(files: Record<string, string>, calls: string[][] = []): DockerHost {
  return {
    runInCertificateDirectory: async (_hostDir: string, argv: string[]) => {
      calls.push(argv);
      const paths = argv.slice(4);
      const output = paths
        .map((path, index) =>
          path in files
            ? `${SEP} ${index + 1} ok\n${files[path]}\n`
            : `${SEP} ${index + 1} not-found\n`,
        )
        .join("");
      return { ok: true, exitCode: 0, output, timedOut: false };
    },
  } as unknown as DockerHost;
}

describe("isValidCertificateFilePath", () => {
  it("accepts relative paths, certbot's and acme.sh's included", () => {
    for (const ok of [
      "live/example.com/fullchain.pem",
      "example.com.crt",
      "*.example.com_ecc/fullchain.cer",
      "live/example.com-0001/privkey.pem",
    ]) {
      expect(isValidCertificateFilePath(ok)).toBe(true);
    }
  });

  it("refuses traversal, absolute paths, NUL and anything a CLI reads as a flag", () => {
    for (const bad of [
      "",
      "..",
      "../etc/shadow",
      "live/../../etc/shadow",
      "/etc/shadow",
      "./live/cert.pem",
      "live//cert.pem",
      "live/cert.pem/",
      "-rf",
      "live/.hidden",
      "live\\cert.pem",
      `live/cert${NUL}.pem`,
      "live/cert pem",
      "a/".repeat(20),
      "x".repeat(1025),
    ]) {
      expect(isValidCertificateFilePath(bad)).toBe(false);
    }
    expect(isValidCertificateFilePath(42)).toBe(false);
  });
});

describe("parseCertificateFileListing", () => {
  it("lists certificates with their names and keys by path alone, in path order", () => {
    const listing = [
      "noise",
      `${SEP} key live/files.example.com/privkey.pem`,
      `${SEP} certificate live/files.example.com/fullchain.pem`,
      CERT_A,
      `${SEP} certificate ../escape.pem`,
      CERT_A,
      `${SEP} certificate archive/broken.pem`,
      "not a certificate",
      `${SEP} secret live/other.pem`,
    ].join("\n");
    const found = parseCertificateFileListing(listing);
    expect(found.map((entry) => entry.path)).toEqual([
      "live/files.example.com/fullchain.pem",
      "live/files.example.com/privkey.pem",
    ]);
    expect(found[0]).toMatchObject({
      kind: "certificate",
      names: ["files.example.com", "www.files.example.com"],
    });
    expect(found[1]).toEqual({ path: "live/files.example.com/privkey.pem", kind: "key" });
  });
});

describe("parseCertificateFileRead", () => {
  it("maps each argument's status by index and refuses an oversized file", () => {
    const big = "x".repeat(1024 * 1024 + 2);
    const output = [
      `${SEP} 1 ok`,
      CERT_A,
      `${SEP} 2 outside-directory`,
      `${SEP} 3 ok`,
      big,
      `${SEP} 9 ok`,
      "ignored",
    ].join("\n");
    const files = parseCertificateFileRead(output, 4);
    expect(files[0]).toMatchObject({ status: "ok" });
    expect(files[1]).toEqual({ status: "outside-directory" });
    expect(files[2]).toEqual({ status: "too-large" });
    expect(files[3]).toEqual({ status: "not-found" });
  });
});

describe("certificatePair", () => {
  it("keeps only the PEM blocks and fingerprints the chain", () => {
    const pair = certificatePair(`junk\n${CERT_A}\ntrailer`, `comment\n${KEY_A}\n`);
    if (!pair.ok) throw new Error(pair.error);
    expect(pair.certificatePem).toBe(CERT_A);
    expect(pair.keyPem).toBe(KEY_A);
    expect(pair.fingerprint).toBe(createHash("sha256").update(CERT_A).digest("hex"));
  });

  it("refuses a key that is not the certificate's", () => {
    expect(certificatePair(CERT_A, KEY_B)).toEqual({ ok: false, error: "key-mismatch" });
  });

  it("refuses files that are not what they are named as", () => {
    expect(certificatePair(KEY_A, KEY_A)).toEqual({ ok: false, error: "not-a-certificate" });
    expect(certificatePair(CERT_A, CERT_A)).toEqual({ ok: false, error: "not-a-key" });
  });
});

describe("readCertificateFiles", () => {
  const sources: CertificateFileSource[] = [
    { id: 1, certPath: "live/a/fullchain.pem", keyPath: "live/a/privkey.pem" },
    { id: 2, certPath: "../../etc/ssl/cert.pem", keyPath: "live/a/privkey.pem" },
    { id: 3, certPath: "/etc/shadow", keyPath: "live/a/privkey.pem" },
    { id: 4, certPath: "live/b/fullchain.pem", keyPath: "live/b/missing.pem" },
  ];

  it("reads valid paths only and reports each failure by code", async () => {
    const calls: string[][] = [];
    const docker = fakeDocker(
      {
        "live/a/fullchain.pem": CERT_A,
        "live/a/privkey.pem": KEY_A,
        "live/b/fullchain.pem": CERT_B,
      },
      calls,
    );
    const results = await readCertificateFiles(config, docker, sources);

    expect(results[0]).toMatchObject({ id: 1, ok: true, certificatePem: CERT_A, keyPem: KEY_A });
    expect(results.slice(1)).toEqual([
      { id: 2, ok: false, error: "invalid-path" },
      { id: 3, ok: false, error: "invalid-path" },
      { id: 4, ok: false, error: "not-found" },
    ]);
    // One container, and no refused path ever reaches it.
    expect(calls).toHaveLength(1);
    const args = calls[0]?.slice(4) ?? [];
    expect(args).not.toContain("../../etc/ssl/cert.pem");
    expect(args).not.toContain("/etc/shadow");
    // Positional arguments after the script, never interpolated into it.
    expect(calls[0]?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(calls[0]?.[3]).toBe("cpm");
  });

  it("reads nothing when the operator configured no directory", async () => {
    const calls: string[][] = [];
    const results = await readCertificateFiles(
      { ...config, certFilesHostDir: null },
      fakeDocker({}, calls),
      sources.slice(0, 1),
    );
    expect(results).toEqual([{ id: 1, ok: false, error: "not-configured" }]);
    expect(calls).toHaveLength(0);
  });
});

describe("the fingerprint diff", () => {
  const full: CertificateFileResult = {
    id: 7,
    ok: true,
    fingerprint: "a".repeat(64),
    certificatePem: CERT_A,
    keyPem: KEY_A,
  };

  it("leaves out the PEM the controller already acknowledged", () => {
    expect(withoutKnownPem([full], new Map())).toEqual([[full]]);
    expect(withoutKnownPem([full], new Map([[7, "a".repeat(64)]]))).toEqual([
      [{ id: 7, ok: true, fingerprint: "a".repeat(64) }],
    ]);
    expect(withoutKnownPem([full], new Map([[7, "b".repeat(64)]]))).toEqual([[full]]);
  });

  it("splits a large read into batches under the request cap", () => {
    const large = { ...full, certificatePem: "x".repeat(900 * 1024) };
    const batches = withoutKnownPem(
      Array.from({ length: 10 }, (_, id) => ({ ...large, id })),
      new Map(),
    );
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(10);
  });

  it("sends the PEM once, then the fingerprint, then the PEM again when asked", async () => {
    const docker = fakeDocker({ "a/cert.pem": CERT_A, "a/key.pem": KEY_A });
    const posted: CertificateFileResult[][] = [];
    let resend: number[] = [];
    const poller = new CertificateFilePoller(config, docker, async (results) => {
      posted.push(results);
      const ack = { resend };
      resend = [];
      return ack;
    });
    try {
      poller.update([{ id: 7, certPath: "a/cert.pem", keyPath: "a/key.pem" }]);
      await poller.poll();
      expect(posted[0]?.[0]).toMatchObject({ id: 7, ok: true, certificatePem: CERT_A });

      // An unchanged frame reads nothing; a poll sends only the fingerprint.
      poller.update([{ id: 7, certPath: "a/cert.pem", keyPath: "a/key.pem" }]);
      await poller.poll();
      const second = posted.at(-1)?.[0];
      expect(second).toEqual({
        id: 7,
        ok: true,
        fingerprint: createHash("sha256").update(CERT_A).digest("hex"),
      });

      resend = [7];
      const before = posted.length;
      await poller.poll();
      // The follow-up read the resend asked for.
      await Bun.sleep(20);
      await poller.poll();
      expect(posted.slice(before).some((batch) => batch[0] && "certificatePem" in batch[0])).toBe(
        true,
      );
    } finally {
      poller.stop();
    }
  });
});

describe("the read container", () => {
  const realSpawn = Bun.spawn;
  let spawned: string[][];

  beforeEach(() => {
    spawned = [];
    (Bun as { spawn: unknown }).spawn = ((argv: string[]) => {
      spawned.push(argv);
      const out = argv[1] === "inspect" ? "sha256:abc" : argv[1] === "wait" ? "0" : "";
      return {
        stdout: new Response(out).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    (Bun as { spawn: unknown }).spawn = realSpawn;
  });

  it("mounts only the directory, read-only, into a locked-down container", async () => {
    await new DockerHost(config).runInCertificateDirectory("/srv/certs", ["sh", "-c", "true"]);
    const create = spawned.find((argv) => argv[1] === "create") ?? [];
    const flag = (name: string) => create[create.indexOf(name) + 1];
    expect(flag("--network")).toBe("none");
    expect(flag("--cap-drop")).toBe("ALL");
    expect(flag("--user")).toBe("0");
    expect(create).toContain("--read-only");
    expect(flag("--mount")).toBe("type=bind,source=/srv/certs,target=/certs,readonly");
    // Caddy's storage stays out, and no second mount of any kind.
    expect(create).not.toContain("--volumes-from");
    expect(create).not.toContain("-v");
    expect(create.filter((arg) => arg === "--mount")).toHaveLength(1);
    expect(create.slice(-3)).toEqual(["sha256:abc", "-c", "true"]);
    // Removed afterwards whatever happened.
    expect(spawned.at(-1)?.slice(0, 3)).toEqual(["docker", "rm", "--force"]);
  });

  it("refuses a relative or comma-carrying directory at startup", () => {
    for (const bad of ["certs", "./certs", "/srv/a,readonly=false"]) {
      process.env.CERT_FILES_HOST_DIR = bad;
      expect(() => loadConfig()).toThrow(/CERT_FILES_HOST_DIR/);
    }
  });
});
