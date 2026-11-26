// @vitest-environment node
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_FILE_SCANNER_ENV,
  SAMPLE_PRIVATE_FILE_SCANNER_ENV,
  privateFileScannerEnvNames,
  privateFileScannerPolicy,
  scanPrivateFileWithClamd,
} from "../api/_lib/privateFileScanner.js";

const VERSION = "ClamAV 1.5.4/28113/Fri Sep  4 06:25:45 2026";
const NOW = Date.parse("2026-09-05T01:00:00Z");
const ENGINE_MIN = "1.5.4";

// Two real key pairs: one is the scanner the pin names, the other is any other
// service that could answer on that port with a certificate our CA signed.
function identity() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return { publicKey, spki };
}
const SCANNER = identity();
const IMPOSTOR = identity();

const servers = [];
afterEach(async () => {
  for (const { server, sockets } of servers.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function scanner(respond, { peer = SCANNER, config: overrides = {} } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const terminator = received.indexOf(0);
      if (terminator < 0) return;
      const command = received.toString("ascii", 0, terminator);
      let payload;
      if (command === "zINSTREAM") {
        let cursor = terminator + 1;
        const pieces = [];
        while (true) {
          if (received.length < cursor + 4) return;
          const size = received.readUInt32BE(cursor); cursor += 4;
          if (size === 0) break;
          if (received.length < cursor + size) return;
          pieces.push(received.subarray(cursor, cursor + size)); cursor += size;
        }
        payload = Buffer.concat(pieces);
      }
      requests.push({ command, payload });
      const reply = respond(command, requests.length);
      if (reply !== undefined) socket.end(reply);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, sockets });
  return {
    requests,
    // Only tests inject a plain loopback connector. Production uses mTLS, and
    // the peer certificate the adapter pins is the real TLS peer's.
    options: {
      config: { host: "scanner.example.test", port: 3310, ca: "test", cert: "test", key: "test",
        expectedSpki: SCANNER.spki, engineMin: ENGINE_MIN, ...overrides },
      connect: () => {
        const socket = connect(server.address().port, "127.0.0.1");
        if (peer) socket.getPeerX509Certificate = () => ({ publicKey: peer.publicKey });
        socket.on("connect", () => socket.emit("secureConnect"));
        return socket;
      },
      now: () => NOW,
    },
  };
}

describe("private file scanner protocol", () => {
  it("binds a complete stream verdict to an immutable copy of the exact bytes", async () => {
    const instance = await scanner((command) => `${command === "zVERSION" ? VERSION : "stream: OK"}\0`);
    const bytes = Buffer.alloc(200000, 65);
    const expected = Buffer.from(bytes);
    const pending = scanPrivateFileWithClamd(bytes, instance.options);
    bytes.fill(66);
    const result = await pending;
    expect(result).toMatchObject({ verdict: "clean", sha256: createHash("sha256").update(expected).digest("hex"), sizeBytes: expected.length,
      engine: "ClamAV 1.5.4", signatureVersion: 28113, signatureDate: "2026-09-04T06:25:45.000Z" });
    expect(instance.requests.map((request) => request.command)).toEqual(["zVERSION", "zINSTREAM", "zVERSION"]);
    expect(instance.requests[1].payload).toEqual(expected);
  });

  it("attests the identity and policy floor it enforced, and nothing more", async () => {
    const instance = await scanner((command) => `${command === "zVERSION" ? VERSION : "stream: OK"}\0`);
    const result = await scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options);
    expect(Object.keys(result).sort()).toEqual([
      "engine", "engineMin", "scannedAt", "scannerSpki", "sha256", "signatureDate", "signatureVersion", "sizeBytes", "verdict",
    ]);
    expect(result.scannerSpki).toBe(SCANNER.spki);
    expect(result.engineMin).toBe(ENGINE_MIN);
    expect(result.scannedAt).toBe(new Date(NOW).toISOString());
    // The attestation names the service, never the host, the certificate
    // material or anything read out of the file.
    expect(JSON.stringify(result)).not.toContain("scanner.example.test");
  });

  it("records a malicious verdict without returning signature text or file content", async () => {
    const instance = await scanner((command) => `${command === "zVERSION" ? VERSION : "stream: Synthetic.Test FOUND"}\0`);
    const result = await scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options);
    expect(result.verdict).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("Synthetic.Test");
  });

  it.each(["stream: OK\n", "stream: OK\0extra", "UNKNOWN COMMAND\0", "stream: Limit ERROR\0", "stream: OK\nstream: Test FOUND\0", "X".repeat(4097)])("fails closed on malformed, truncated or scanner-error replies", async (reply) => {
    const instance = await scanner((command) => command === "zVERSION" ? `${VERSION}\0` : reply);
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options)).rejects.toThrow(/private-file-scanner/);
  });

  it("classifies a peer that completes the handshake then closes without a byte as unavailable", async () => {
    // A ghostunnel authorization refusal has exactly this shape: the client
    // certificate chains to the CA so the TLS handshake completes, then the
    // listener closes the connection because the presented leaf is not on its
    // allowlist, sending no application reply. That is an availability failure,
    // not a malformed reply, and must classify as -unavailable so it matches
    // the connection-level `error`/`close` result rather than -invalid-reply.
    const instance = await scanner(() => "");
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options)).rejects.toThrow("private-file-scanner-unavailable");
    expect(instance.requests).toEqual([{ command: "zVERSION", payload: undefined }]);
  });

  it.each(["ClamAV 1.5.4/1/Sun Aug 30 00:00:00 2026", "ClamAV 1.5.4/1/Sun Sep  6 00:00:00 2026", "not a version"]) ("refuses stale, future or unparseable signature provenance before uploading bytes", async (version) => {
    const instance = await scanner(() => `${version}\0`);
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options)).rejects.toThrow(/private-file-scanner/);
    expect(instance.requests).toHaveLength(1);
  });

  it.each(["ClamAV 1.5.3/28113/Fri Sep  4 06:25:45 2026", "ClamAV 1.4.9/28113/Fri Sep  4 06:25:45 2026", "ClamAV 0.105.2/28113/Fri Sep  4 06:25:45 2026"])("refuses an engine below the reviewed minimum before uploading bytes", async (version) => {
    const instance = await scanner(() => `${version}\0`);
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options)).rejects.toThrow("private-file-scanner-engine");
    expect(instance.requests).toHaveLength(1);
  });

  it.each(["ClamAV 1.5.5/28113/Fri Sep  4 06:25:45 2026", "ClamAV 1.6.0/28113/Fri Sep  4 06:25:45 2026", "ClamAV 2.0.0/28113/Fri Sep  4 06:25:45 2026"])("accepts an engine at or above the reviewed minimum", async (version) => {
    const instance = await scanner((command) => `${command === "zVERSION" ? version : "stream: OK"}\0`);
    const result = await scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options);
    expect(result.engine).toBe(`ClamAV ${version.split("/")[0].replace("ClamAV ", "")}`);
  });

  it("refuses a scan spanning a signature reload", async () => {
    const instance = await scanner((command, count) => `${command === "zINSTREAM" ? "stream: OK" : count === 1 ? VERSION : VERSION.replace("28113", "28114")}\0`);
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options)).rejects.toThrow(/changed/);
  });

  it("enforces the wall-clock deadline even if the scanner remains connected", async () => {
    const instance = await scanner(() => undefined);
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), { ...instance.options, timeoutMs: 30 })).rejects.toThrow(/unavailable/);
  });

  it("refuses missing mutual TLS configuration and invalid file sizes", async () => {
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), { config: {} })).rejects.toThrow(/configuration/);
    const instance = await scanner(() => undefined);
    await expect(scanPrivateFileWithClamd(Buffer.alloc(0), instance.options)).rejects.toThrow(/size/);
    await expect(scanPrivateFileWithClamd(Buffer.alloc(10 * 1024 * 1024 + 1), instance.options)).rejects.toThrow(/size/);
    expect(instance.requests).toHaveLength(0);
  });
});

describe("private file scanner identity", () => {
  it("refuses a peer whose public key is not the pinned one, before sending a command", async () => {
    const instance = await scanner((command) => `${command === "zVERSION" ? VERSION : "stream: OK"}\0`, { peer: IMPOSTOR });
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options)).rejects.toThrow("private-file-scanner-identity");
    expect(instance.requests).toHaveLength(0);
  });

  it("refuses a peer that presents no certificate at all", async () => {
    const instance = await scanner((command) => `${command === "zVERSION" ? VERSION : "stream: OK"}\0`, { peer: null });
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), instance.options)).rejects.toThrow("private-file-scanner-identity");
    expect(instance.requests).toHaveLength(0);
  });

  it("re-proves the pin on the connection that carries the file bytes, not only the first one", async () => {
    let opened = 0;
    const instance = await scanner((command) => `${command === "zVERSION" ? VERSION : "stream: OK"}\0`);
    const connectFirstOnly = instance.options.connect;
    const options = { ...instance.options, connect: (connection) => {
      const socket = connectFirstOnly(connection);
      opened += 1;
      if (opened > 1) socket.getPeerX509Certificate = () => ({ publicKey: IMPOSTOR.publicKey });
      return socket;
    } };
    await expect(scanPrivateFileWithClamd(Buffer.from("synthetic"), options)).rejects.toThrow("private-file-scanner-identity");
    expect(instance.requests.map((request) => request.command)).toEqual(["zVERSION"]);
  });
});

describe("private file scanner policy", () => {
  const complete = {
    PRIVATE_FILE_SCANNER_HOST: "scanner.example.test",
    PRIVATE_FILE_SCANNER_PORT: "3310",
    PRIVATE_FILE_SCANNER_CA: "ca-pem",
    PRIVATE_FILE_SCANNER_CERT: "cert-pem",
    PRIVATE_FILE_SCANNER_KEY: "key-pem",
    PRIVATE_FILE_SCANNER_EXPECTED_SPKI: SCANNER.spki,
    PRIVATE_FILE_SCANNER_ENGINE_MIN: ENGINE_MIN,
  };

  const sample = Object.fromEntries(Object.entries(complete)
    .map(([name, value]) => [`SAMPLE_${name}`, value === "scanner.example.test" ? "sample-scanner.example.test" : value]));
  sample.SAMPLE_PRIVATE_FILE_SCANNER_PORT = "8444";
  sample.SAMPLE_PRIVATE_FILE_SCANNER_CERT = "sample-cert-pem";
  sample.SAMPLE_PRIVATE_FILE_SCANNER_KEY = "sample-key-pem";

  it("names every required value exactly once and reads all of them", () => {
    expect([...PRIVATE_FILE_SCANNER_ENV]).toEqual([...new Set(PRIVATE_FILE_SCANNER_ENV)]);
    expect([...PRIVATE_FILE_SCANNER_ENV].sort()).toEqual(Object.keys(complete).sort());
    expect(privateFileScannerPolicy(complete, "saas")).toEqual({
      host: "scanner.example.test", port: 3310, ca: "ca-pem", cert: "cert-pem", key: "key-pem",
      expectedSpki: SCANNER.spki, engineMin: ENGINE_MIN,
    });
  });

  it("selects all seven SAMPLE values together when every production value differs", () => {
    const distinctSample = {
      SAMPLE_PRIVATE_FILE_SCANNER_HOST: "independent-scanner.example.test",
      SAMPLE_PRIVATE_FILE_SCANNER_PORT: "4310",
      SAMPLE_PRIVATE_FILE_SCANNER_CA: "independent-ca-pem",
      SAMPLE_PRIVATE_FILE_SCANNER_CERT: "independent-cert-pem",
      SAMPLE_PRIVATE_FILE_SCANNER_KEY: "independent-key-pem",
      SAMPLE_PRIVATE_FILE_SCANNER_EXPECTED_SPKI: IMPOSTOR.spki,
      SAMPLE_PRIVATE_FILE_SCANNER_ENGINE_MIN: "1.5.5",
    };
    const both = { ...complete, ...distinctSample };
    expect(Object.isFrozen(SAMPLE_PRIVATE_FILE_SCANNER_ENV)).toBe(true);
    expect(privateFileScannerPolicy(both, "demo")).toEqual({
      host: "independent-scanner.example.test", port: 4310,
      ca: "independent-ca-pem", cert: "independent-cert-pem", key: "independent-key-pem",
      expectedSpki: IMPOSTOR.spki, engineMin: "1.5.5",
    });
    expect(privateFileScannerPolicy(both, "saas")).toEqual(privateFileScannerPolicy(complete, "saas"));
  });

  it.each(PRIVATE_FILE_SCANNER_ENV)("refuses missing production %s despite a complete SAMPLE family", (name) => {
    const both = { ...complete, ...sample };
    delete both[name];
    expect(() => privateFileScannerPolicy(both, "saas")).toThrow("private-file-scanner-configuration");
    expect(() => privateFileScannerPolicy({ ...both, [name]: "" }, "saas")).toThrow("private-file-scanner-configuration");
    expect(() => privateFileScannerPolicy(both, "demo")).not.toThrow();
  });

  it("names the SAMPLE twins as the production names with one prefix, and routes each surface to its own family", () => {
    expect([...SAMPLE_PRIVATE_FILE_SCANNER_ENV])
      .toEqual(PRIVATE_FILE_SCANNER_ENV.map((name) => `SAMPLE_${name}`));
    expect([...SAMPLE_PRIVATE_FILE_SCANNER_ENV].sort()).toEqual(Object.keys(sample).sort());
    expect(privateFileScannerEnvNames("saas")).toEqual(PRIVATE_FILE_SCANNER_ENV);
    expect(privateFileScannerEnvNames("demo")).toEqual(SAMPLE_PRIVATE_FILE_SCANNER_ENV);
    // Both families set: each surface reads only its own, so revoking one
    // surface's client certificate cannot disturb the other.
    const both = { ...complete, ...sample };
    expect(privateFileScannerPolicy(both, "saas")).toMatchObject({
      host: "scanner.example.test", port: 3310, cert: "cert-pem", key: "key-pem",
    });
    expect(privateFileScannerPolicy(both, "demo")).toMatchObject({
      host: "sample-scanner.example.test", port: 8444, cert: "sample-cert-pem", key: "sample-key-pem",
    });
  });

  it("fails closed per surface rather than borrowing the other surface's identity", () => {
    // Production configured, SAMPLE twins absent: the SAMPLE surface is 503 and
    // never presents the production client certificate to the production
    // listener. This is exactly H7's acceptance criterion.
    expect(() => privateFileScannerPolicy(complete, "demo")).toThrow("private-file-scanner-configuration");
    expect(privateFileScannerPolicy(complete, "saas")).toMatchObject({ cert: "cert-pem" });
    // And the reverse: SAMPLE alone does not activate the SaaS surface.
    expect(() => privateFileScannerPolicy(sample, "saas")).toThrow("private-file-scanner-configuration");
    expect(privateFileScannerPolicy(sample, "demo")).toMatchObject({ cert: "sample-cert-pem" });
  });

  it.each([undefined, "", "production", "sample", "SAAS", "DEMO", "SAMPLE_", "toString", "constructor", "__proto__", 0, null, {}, ["saas"]])(
    "refuses an unrecognised surface (%p) instead of defaulting to production", (surface) => {
      const both = { ...complete, ...sample };
      expect(() => privateFileScannerPolicy(both, surface)).toThrow("private-file-scanner-configuration");
      expect(() => privateFileScannerEnvNames(surface)).toThrow("private-file-scanner-configuration");
    },
  );

  it.each(PRIVATE_FILE_SCANNER_ENV)("refuses the whole configuration when %s is missing", (name) => {
    const partial = { ...complete };
    delete partial[name];
    expect(() => privateFileScannerPolicy(partial, "saas")).toThrow("private-file-scanner-configuration");
    expect(() => privateFileScannerPolicy({ ...complete, [name]: "" }, "saas")).toThrow("private-file-scanner-configuration");
  });

  it.each(SAMPLE_PRIVATE_FILE_SCANNER_ENV)("refuses the SAMPLE surface when %s is missing", (name) => {
    const partial = { ...complete, ...sample };
    delete partial[name];
    expect(() => privateFileScannerPolicy(partial, "demo")).toThrow("private-file-scanner-configuration");
    expect(() => privateFileScannerPolicy({ ...complete, ...sample, [name]: "" }, "demo"))
      .toThrow("private-file-scanner-configuration");
    // The production surface is untouched by a missing twin.
    expect(privateFileScannerPolicy(partial, "saas")).toMatchObject({ cert: "cert-pem" });
  });

  it.each([
    ["PRIVATE_FILE_SCANNER_HOST", "scanner example test"],
    ["PRIVATE_FILE_SCANNER_HOST", "https://scanner.example.test"],
    ["PRIVATE_FILE_SCANNER_PORT", "0"],
    ["PRIVATE_FILE_SCANNER_PORT", "65536"],
    ["PRIVATE_FILE_SCANNER_PORT", "3310.5"],
    ["PRIVATE_FILE_SCANNER_PORT", "not-a-port"],
    ["PRIVATE_FILE_SCANNER_CA", "   "],
    // A hex digest, a truncated pin and a fingerprint of the certificate rather
    // than of the SubjectPublicKeyInfo all look plausible and are all wrong.
    ["PRIVATE_FILE_SCANNER_EXPECTED_SPKI", "a".repeat(64)],
    ["PRIVATE_FILE_SCANNER_EXPECTED_SPKI", SCANNER.spki.slice(0, -1)],
    ["PRIVATE_FILE_SCANNER_EXPECTED_SPKI", `sha256/${SCANNER.spki}`],
    ["PRIVATE_FILE_SCANNER_ENGINE_MIN", "1.5"],
    ["PRIVATE_FILE_SCANNER_ENGINE_MIN", "v1.5.4"],
    ["PRIVATE_FILE_SCANNER_ENGINE_MIN", "latest"],
  ])("refuses a malformed %s", (name, value) => {
    expect(() => privateFileScannerPolicy({ ...complete, [name]: value }, "saas")).toThrow("private-file-scanner-configuration");
    expect(() => privateFileScannerPolicy({ ...complete, ...sample, [`SAMPLE_${name}`]: value }, "demo"))
      .toThrow("private-file-scanner-configuration");
  });
});
