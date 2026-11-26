import { decryptInspectedCaseDocument } from "../api/_lib/sensitiveCaseDocuments.js";
// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/private-files.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { downloadPrivateObjectBytes } from "../api/_lib/privateFileDownload.js";
import { inspectPrivateFileInWorker } from "../api/_lib/privateFileInspection.js";
import { PRIVATE_FILE_SCANNER_ENV, scanPrivateFileWithClamd } from "../api/_lib/privateFileScanner.js";
import { decryptInspectedFormDocument, sealedFormInspectionRow } from "../api/_lib/sensitiveFormDocuments.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("../api/_lib/sensitiveCaseDocuments.js", () => ({ decryptInspectedCaseDocument: vi.fn(async (_backend, _target, bytes) => bytes) }));
vi.mock("../api/_lib/sensitiveFormDocuments.js", () => ({ sealedFormInspectionRow: vi.fn(), decryptInspectedFormDocument: vi.fn() }));
vi.mock("../api/_lib/privateFileDownload.js", () => ({ downloadPrivateObjectBytes: vi.fn() }));
vi.mock("../api/_lib/privateFileInspection.js", () => ({ inspectPrivateFileInWorker: vi.fn() }));
// Only the network exchange is mocked. The scanner policy stays real so the
// handler's configuration boundary is proved against the actual validator.
vi.mock("../api/_lib/privateFileScanner.js", async (importOriginal) => ({
  ...await importOriginal(), scanPrivateFileWithClamd: vi.fn(),
}));
const FILE = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const OBJECT = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from("synthetic");
const sha256 = createHash("sha256").update(bytes).digest("hex");
let target;
let finish;
function response() {
  return { code: 0, headers: {}, body: null,
    status(code) { this.code = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = JSON.parse(body); },
  };
}
async function call(body = { kind: "case", fileId: FILE }, headers = {}, method = "POST") {
  const res = response();
  await handler({ method, headers: { host: PORTAL_HOST, authorization: "Bearer user-token", ...headers }, body }, res);
  return res;
}
beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: SUPABASE_ORIGIN, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "public-key", SUPABASE_SERVICE_ROLE_KEY: "service-key",
    PRIVATE_FILE_SCANNER_HOST: "scanner.example.invalid", PRIVATE_FILE_SCANNER_PORT: "3311",
    PRIVATE_FILE_SCANNER_CA: "synthetic-ca", PRIVATE_FILE_SCANNER_CERT: "synthetic-cert", PRIVATE_FILE_SCANNER_KEY: "synthetic-key",
    PRIVATE_FILE_SCANNER_EXPECTED_SPKI: "OVEdIiR2/Nn5dSKQFZlJ8sQtCnfYZGHxna0gdgzuW8c=", PRIVATE_FILE_SCANNER_ENGINE_MIN: "1.5.4",
  })) vi.stubEnv(key, value);
  target = { fileId: FILE, attemptId: ATTEMPT, objectId: OBJECT, objectVersion: "1", bucketId: "case-files", objectName: "authorized/synthetic.txt",
    filename: "synthetic.txt", mimeType: "text/plain", sizeBytes: bytes.length, sha256: null, current: false };
  finish = { status: "clean" };
  vi.stubGlobal("fetch", vi.fn(async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(String(url).includes("authorize_private_upload_inspection") ? target : finish) })));
  vi.mocked(decryptInspectedCaseDocument).mockResolvedValue(bytes);
  vi.mocked(sealedFormInspectionRow).mockResolvedValue(null);
  vi.mocked(decryptInspectedFormDocument).mockReturnValue(bytes);
  vi.mocked(downloadPrivateObjectBytes).mockResolvedValue(bytes);
  vi.mocked(inspectPrivateFileInWorker).mockResolvedValue({ profile: "structure-only", mimeType: "text/plain", sizeBytes: bytes.length, sha256 });
  vi.mocked(scanPrivateFileWithClamd).mockResolvedValue({ verdict: "clean", sizeBytes: bytes.length, sha256, engine: "ClamAV 1.5.4",
    signatureVersion: 28113, signatureDate: new Date().toISOString(), scannedAt: new Date().toISOString() });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("private file scanner surface isolation", () => {
  const sampleConfig = {
    host: "sample-scanner.example.invalid", port: 4311,
    ca: "sample-ca", cert: "sample-cert", key: "sample-key",
    expectedSpki: createHash("sha256").update("sample-scanner").digest("base64"), engineMin: "1.5.5",
  };
  const productionConfig = {
    host: "scanner.example.invalid", port: 3311,
    ca: "synthetic-ca", cert: "synthetic-cert", key: "synthetic-key",
    expectedSpki: "OVEdIiR2/Nn5dSKQFZlJ8sQtCnfYZGHxna0gdgzuW8c=", engineMin: "1.5.4",
  };
  beforeEach(() => {
    for (const [key, value] of Object.entries({
      SAMPLE_SUPABASE_URL: "https://samplefictionalproj.supabase.co",
      SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-public-key", SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service-key",
      SAMPLE_PRIVATE_FILE_SCANNER_HOST: sampleConfig.host, SAMPLE_PRIVATE_FILE_SCANNER_PORT: String(sampleConfig.port),
      SAMPLE_PRIVATE_FILE_SCANNER_CA: sampleConfig.ca, SAMPLE_PRIVATE_FILE_SCANNER_CERT: sampleConfig.cert,
      SAMPLE_PRIVATE_FILE_SCANNER_KEY: sampleConfig.key, SAMPLE_PRIVATE_FILE_SCANNER_EXPECTED_SPKI: sampleConfig.expectedSpki,
      SAMPLE_PRIVATE_FILE_SCANNER_ENGINE_MIN: sampleConfig.engineMin,
    })) vi.stubEnv(key, value);
  });

  // Union Ground pins no SAMPLE project, so only the trusted portal host resolves a backend.
  // A forwarded header never moves a request between hosts, and the demo host
  // never reaches the backend or the scanner even with a complete SAMPLE_* family.
  it.each([
    [PORTAL_HOST, SAMPLE_HOST],
    [`${PORTAL_HOST.toUpperCase()}.:443`, SAMPLE_HOST],
  ])("keeps backend and scanner identity together for Host %s despite forwarded %s", async (host, forwarded) => {
    expect((await call(undefined, { host, "x-forwarded-host": forwarded, "x-vercel-cron": "1" })).code).toBe(200);
    const [authorize, finishCall] = global.fetch.mock.calls;
    expect(authorize[0]).toBe(`${SUPABASE_ORIGIN}/rest/v1/rpc/authorize_private_upload_inspection`);
    expect(authorize[1].headers.apikey).toBe("public-key");
    expect(finishCall[0]).toBe(`${SUPABASE_ORIGIN}/rest/v1/rpc/finish_private_upload_inspection`);
    expect(finishCall[1].headers.Authorization).toBe("Bearer service-key");
    expect(downloadPrivateObjectBytes).toHaveBeenCalledWith(expect.objectContaining({ surface: "saas" }), target, expect.any(Object));
    expect(scanPrivateFileWithClamd).toHaveBeenCalledWith(bytes, expect.objectContaining({ config: productionConfig }));
  });

  it.each([
    [SAMPLE_HOST, PORTAL_HOST],
    [`www.${SAMPLE_HOST}`, PORTAL_HOST],
    [`${SAMPLE_HOST.toUpperCase()}.:443`, PORTAL_HOST],
  ])("refuses Host %s before I/O despite forwarded %s and a complete SAMPLE_* family", async (host, forwarded) => {
    const res = await call(undefined, { host, "x-forwarded-host": forwarded, "x-vercel-cron": "1" });
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ error: "file-check-unavailable" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(downloadPrivateObjectBytes).not.toHaveBeenCalled();
    expect(scanPrivateFileWithClamd).not.toHaveBeenCalled();
  });

  it.each(PRIVATE_FILE_SCANNER_ENV.flatMap(name => [
    [SAMPLE_HOST, `SAMPLE_${name}`], [PORTAL_HOST, name],
  ]))("refuses %s before I/O when selected %s is absent despite a complete other surface", async (host, name) => {
    vi.stubEnv(name, "");
    const res = await call(undefined, { host });
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ error: "file-check-unavailable" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(downloadPrivateObjectBytes).not.toHaveBeenCalled();
    expect(inspectPrivateFileInWorker).not.toHaveBeenCalled();
    expect(scanPrivateFileWithClamd).not.toHaveBeenCalled();
  });

  it("does not let query parameters or an extra body field select scanner credentials", async () => {
    const res = response();
    await handler({ method: "POST", url: "/api/private-files?surface=demo&scannerPrefix=SAMPLE_",
      headers: { host: PORTAL_HOST, authorization: "Bearer user-token", "x-scanner-surface": "demo" },
      body: { kind: "case", fileId: FILE } }, res);
    expect(res.code).toBe(200);
    expect(scanPrivateFileWithClamd).toHaveBeenCalledWith(bytes, expect.objectContaining({ config: productionConfig }));
    vi.mocked(scanPrivateFileWithClamd).mockClear();
    global.fetch.mockClear();
    expect((await call({ kind: "case", fileId: FILE, surface: "demo" })).code).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(scanPrivateFileWithClamd).not.toHaveBeenCalled();
  });
});

describe("private file inspection API", () => {
  it("decrypts a sealed form attachment before inspection and scanning, without comparing ciphertext to its plaintext hash", async () => {
    target = { ...target, bucketId: "member-form-files", sha256 };
    const sealed = { id: FILE, encrypted_content: { dataVersion: "sealed-version" } };
    const ciphertext = Buffer.from("opaque ciphertext");
    vi.mocked(sealedFormInspectionRow).mockResolvedValue(sealed);
    vi.mocked(downloadPrivateObjectBytes).mockResolvedValue(ciphertext);
    const result = await call({ kind: "form", fileId: FILE });
    expect(result.code).toBe(200);
    expect(sealedFormInspectionRow).toHaveBeenCalledWith(expect.objectContaining({ surface: "saas" }), target);
    expect(downloadPrivateObjectBytes).toHaveBeenCalledWith(expect.any(Object), { ...target, sha256: null }, expect.any(Object));
    expect(decryptInspectedFormDocument).toHaveBeenCalledWith(expect.any(Object), sealed, ciphertext);
    expect(inspectPrivateFileInWorker).toHaveBeenCalledWith(bytes, expect.any(Object));
    expect(scanPrivateFileWithClamd).toHaveBeenCalledWith(bytes, expect.any(Object));
    expect(decryptInspectedCaseDocument).not.toHaveBeenCalled();
  });

  it("does not download or scan a form when its attempt-bound encryption metadata is unavailable", async () => {
    vi.mocked(sealedFormInspectionRow).mockRejectedValue(new Error("sensitive-document-unavailable"));
    expect((await call({ kind: "form", fileId: FILE })).code).toBe(503);
    expect(downloadPrivateObjectBytes).not.toHaveBeenCalled();
    expect(inspectPrivateFileInWorker).not.toHaveBeenCalled();
    expect(scanPrivateFileWithClamd).not.toHaveBeenCalled();
  });

  it("authorizes with the caller, inspects stored bytes and binds a privileged verdict to the server attempt", async () => {
    const res = await call();
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ fileId: FILE, status: "clean" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const [authorize, record] = global.fetch.mock.calls;
    expect(authorize[1].headers.Authorization).toBe("Bearer user-token");
    expect(JSON.parse(authorize[1].body)).toEqual({ p_kind: "case", p_file_id: FILE });
    expect(record[1].headers.Authorization).toBe("Bearer service-key");
    expect(JSON.parse(record[1].body)).toMatchObject({ p_attempt_id: ATTEMPT, p_sha256: sha256, p_verdict: "clean" });
    expect(downloadPrivateObjectBytes).toHaveBeenCalledWith(expect.objectContaining({ serviceRoleKey: "service-key" }), target, expect.any(Object));
    expect(inspectPrivateFileInWorker).toHaveBeenCalledBefore(scanPrivateFileWithClamd);
  });
  it.each([{ origin: "https://evil.example" }, { cookie: "session=x" }])("rejects untrusted browser requests before I/O", async (headers) => {
    expect((await call(undefined, headers)).code).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each([{ kind: "case", fileId: FILE, objectName: "foreign/file" }, { kind: "case", fileId: FILE, verdict: "clean" }, { kind: "other", fileId: FILE }, { kind: ["case"], fileId: FILE }, { kind: "case", fileId: "bad" }, null])("rejects caller-controlled targets or malformed bodies", async (body) => {
    expect((await call(body)).code).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("requires a bearer, POST and a configured authenticated scanner", async () => {
    expect((await call(undefined, { authorization: "", origin: PORTAL_ORIGIN })).code).toBe(401);
    expect((await call(undefined, {}, "GET")).code).toBe(405);
    vi.stubEnv("PRIVATE_FILE_SCANNER_KEY", "");
    expect((await call()).code).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  // The scanner identity pin and the engine floor are as load-bearing as the
  // key material: a deployment missing or drifting on either has no attested
  // scanner, so it inspects nothing rather than trusting whatever answers.
  it.each([
    ["PRIVATE_FILE_SCANNER_EXPECTED_SPKI", ""],
    ["PRIVATE_FILE_SCANNER_EXPECTED_SPKI", "not-a-pin"],
    ["PRIVATE_FILE_SCANNER_ENGINE_MIN", ""],
    ["PRIVATE_FILE_SCANNER_ENGINE_MIN", "1.5"],
    ["PRIVATE_FILE_SCANNER_HOST", "scanner example invalid"],
    ["PRIVATE_FILE_SCANNER_PORT", "70000"],
  ])("stays unavailable when %s is missing or malformed", async (name, value) => {
    vi.stubEnv(name, value);
    expect((await call()).code).toBe(503);
    expect((await call()).body).toEqual({ error: "file-check-unavailable" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  // A stale MFA session and a row the caller may not see are NOT the same
  // answer. The row-shaped refusals stay merged into one 403 — unknown,
  // foreign, removed and unauthorized are indistinguishable, so the endpoint
  // cannot be used to enumerate file ids — while the session refusal, which
  // the RPC decides before it looks at p_file_id and therefore leaks nothing,
  // gets its own 401. That distinction is what lets native durable recovery
  // stop treating a row the service reconciler deleted as a reason to
  // reauthenticate forever.
  it("separates a stale session from a row it will not talk about, and downloads for neither", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      target = { reauthRequired: true };
      const reauth = await call();
      expect(reauth.code).toBe(401);
      expect(reauth.body).toEqual({ error: "file-check-reauth-required" });
      expect(logged).toHaveBeenCalledWith("[private-files]", { kind: "case", outcome: "reauth" });

      logged.mockClear();
      global.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
      const refused = await call({ kind: "knowledge", fileId: FILE });
      expect(refused.code).toBe(403);
      expect(refused.body).toEqual({ error: "not-authorized" });
      expect(logged).toHaveBeenCalledWith("[private-files]", { kind: "knowledge", outcome: "authorization-or-lifecycle" });

      // Neither answer names a file, a bucket, a path or a token.
      for (const [, details] of logged.mock.calls) {
        expect(JSON.stringify(details)).not.toContain(FILE);
        expect(JSON.stringify(details)).not.toContain("authorized/synthetic.txt");
        expect(JSON.stringify(details)).not.toContain("user-token");
      }
      expect(downloadPrivateObjectBytes).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
  // A refusal and an outage are not the same answer, and only one of them is a
  // decision. Both clients treat 403 as final — the native upload path reports
  // that MFA must be repeated — so a timed-out or 5xx authorization call used
  // to strand an upload behind a reauthentication that could not fix it.
  it("answers an authorization outage with the retryable 503, and a refusal with 403", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const outage of [
        { ok: false, status: 500 },
        { ok: false, status: 502 },
        { ok: false, status: 404 },
        { ok: false, status: 400 },
        // A 200 whose body is empty or unparseable: supabaseRpc throws with no
        // status at all, which is the server failing to decide.
        { ok: true, status: 200, text: async () => "" },
        { ok: true, status: 200, text: async () => "{" },
      ]) {
        logged.mockClear();
        global.fetch.mockResolvedValueOnce(outage);
        const res = await call();
        expect(res.code, `status ${outage.status}`).toBe(503);
        expect(res.body).toEqual({ error: "file-check-unavailable" });
        expect(logged).toHaveBeenCalledWith("[private-files]", { kind: "case", outcome: "authorization-unavailable" });
      }

      // A dropped connection or a timeout is the same class.
      logged.mockClear();
      global.fetch.mockRejectedValueOnce(new TypeError("network"));
      expect((await call()).code).toBe(503);
      expect(logged).toHaveBeenCalledWith("[private-files]", { kind: "case", outcome: "authorization-unavailable" });

      // The split reads only the transport status, so an unauthorized caller
      // still receives exactly the 403 an absent row receives.
      for (const status of [401, 403]) {
        logged.mockClear();
        global.fetch.mockResolvedValueOnce({ ok: false, status });
        const res = await call();
        expect(res.code).toBe(403);
        expect(res.body).toEqual({ error: "not-authorized" });
        expect(logged).toHaveBeenCalledWith("[private-files]", { kind: "case", outcome: "authorization-or-lifecycle" });
      }
      expect(downloadPrivateObjectBytes).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("does not download on authorization denial, quota exhaustion or an existing current verdict", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    expect((await call()).code).toBe(403);
    target = { rateLimited: true };
    expect((await call()).code).toBe(429);
    target = { busy: true };
    expect((await call()).code).toBe(409);
    target = { fileId: FILE, current: true };
    expect((await call()).body).toEqual({ fileId: FILE, status: "clean" });
    expect(downloadPrivateObjectBytes).not.toHaveBeenCalled();
  });
  it("tells a busy or rate-limited caller how long to wait instead of leaving it to guess", async () => {
    // The lease is 60 s and the quota window is an hour; both numbers are the
    // server's, and a client that guesses shorter spends quota it cannot use.
    target = { busy: true };
    const busy = await call();
    expect(busy.code).toBe(409);
    // The hint is a POLL INTERVAL, not the remaining wait: the RPC reserves a
    // 60 s lease and does not say how much of it is left, and a legitimate
    // inspection can hold most of it (a 10 s download plus a 20 s scan). Two
    // seconds told an honest client to give up mid-scan.
    expect(busy.headers["Retry-After"]).toBe("5");
    target = { rateLimited: true };
    const limited = await call();
    expect(limited.code).toBe(429);
    expect(limited.headers["Retry-After"]).toBe("3600");
    // A retry hint is never attached to a decision that retrying cannot change.
    vi.mocked(inspectPrivateFileInWorker).mockRejectedValueOnce(new Error("private-file-image-metadata"));
    target = { fileId: FILE, attemptId: ATTEMPT, objectId: OBJECT, objectVersion: "1", bucketId: "case-files",
      objectName: "authorized/synthetic.txt", filename: "synthetic.txt", mimeType: "text/plain",
      sizeBytes: bytes.length, sha256: null, current: false };
    finish = { status: "blocked" };
    const rejected = await call();
    expect(rejected.code).toBe(422);
    expect(rejected.headers).not.toHaveProperty("Retry-After");
  });
  it("rejects a mismatched authorized target before privileged storage access", async () => {
    target.bucketId = "organization-knowledge";
    expect((await call()).code).toBe(503);
    expect(downloadPrivateObjectBytes).not.toHaveBeenCalled();
  });
  it("records structural rejection as blocked without scanning and never emits parser details", async () => {
    // `blocked`, not `failed`: a refusal is a permanent decision about these
    // bytes, while `failed` means "we could not decide" and stays retryable.
    vi.mocked(inspectPrivateFileInWorker).mockRejectedValue(new Error("private-file-image-metadata"));
    finish = { status: "blocked" };
    const res = await call();
    expect(res.code).toBe(422);
    expect(res.body).toEqual({ error: "file-rejected" });
    expect(scanPrivateFileWithClamd).not.toHaveBeenCalled();
    const verdicts = global.fetch.mock.calls
      .filter(([url]) => String(url).includes("finish_private_upload_inspection"))
      .map(([, init]) => JSON.parse(init.body));
    expect(verdicts).toEqual([expect.objectContaining({ p_attempt_id: ATTEMPT, p_verdict: "blocked" })]);
  });
  it("still records a refusal the ledger will not accept as blocked, rather than leaving the row pending", async () => {
    // `private.record_private_upload_scan` demands scanner provenance for
    // `blocked`, which a refusal raised before the scan ran cannot supply.
    // Until the ledger admits a provenance-free structural refusal, the
    // fallback keeps the row at least as informative as it is today. Every one
    // of pending/failed/blocked denies every gate.
    vi.mocked(inspectPrivateFileInWorker).mockRejectedValue(new Error("private-file-archive-executable"));
    global.fetch.mockImplementation(async (url, init) => {
      if (String(url).includes("authorize_private_upload_inspection")) {
        return { ok: true, status: 200, text: async () => JSON.stringify(target) };
      }
      if (JSON.parse(init.body).p_verdict === "blocked") return { ok: false, status: 400 };
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "failed" }) };
    });
    const res = await call();
    expect(res.code).toBe(422);
    const verdicts = global.fetch.mock.calls
      .filter(([url]) => String(url).includes("finish_private_upload_inspection"))
      .map(([, init]) => JSON.parse(init.body).p_verdict);
    expect(verdicts).toEqual(["blocked", "failed"]);
  });
  it.each([
    ["private-file-size", 503, "file-check-unavailable"],
    ["private-file-sizeless-foo", 503, "file-check-unavailable"],
    ["private-file-size-mismatch", 422, "file-rejected"],
    ["private-file-executable", 422, "file-rejected"],
    ["private-file-pdf-inspection-busy", 503, "file-check-unavailable"],
    ["private-file-inspection-budget", 503, "file-check-unavailable"],
  ])("classifies %s as %i", async (message, code, error) => {
    // A server-side bound on the downloaded byte length (`private-file-size`)
    // is not a caller-visible defect; only the safety inspector's own
    // `size-mismatch`/`size-invalid-input` are. Matching a bare `size` told a
    // member their file was rejected when the server had failed.
    vi.mocked(inspectPrivateFileInWorker).mockRejectedValue(new Error(message));
    finish = { status: code === 422 ? "blocked" : "failed" };
    const res = await call();
    expect(res.code).toBe(code);
    expect(res.body).toEqual({ error });
    expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body).p_verdict).toBe(code === 422 ? "blocked" : "failed");
  });
  it("records malware as blocked and withholds success", async () => {
    vi.mocked(scanPrivateFileWithClamd).mockResolvedValueOnce({ ...await scanPrivateFileWithClamd(), verdict: "blocked" });
    finish = { status: "blocked" };
    const res = await call();
    expect(res.code).toBe(422);
    expect(JSON.parse(global.fetch.mock.calls.at(-1)[1].body).p_verdict).toBe("blocked");
  });
  it.each(["download", "scanner", "digest", "record"])("fails closed on %s failure", async (stage) => {
    if (stage === "download") vi.mocked(downloadPrivateObjectBytes).mockRejectedValueOnce(new Error("private upstream path"));
    if (stage === "scanner") vi.mocked(scanPrivateFileWithClamd).mockRejectedValueOnce(new Error("private TLS details"));
    if (stage === "digest") vi.mocked(scanPrivateFileWithClamd).mockResolvedValueOnce({ ...await scanPrivateFileWithClamd(), sha256: "0".repeat(64) });
    if (stage === "record") finish = {};
    const res = await call();
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ error: "file-check-unavailable" });
    expect(JSON.stringify(res.body)).not.toContain("private");
  });
});

// H7: one deployment serves both hosted surfaces, so the scanner credential has
// to route the way the Supabase credential already routes. Without this the
// SAMPLE host would present the production client certificate to the production
// listener, and revoking SAMPLE's identity would take production down with it.
describe("private file inspection API — per-surface scanner identity", () => {
  const SAMPLE_SUPABASE = "https://samplefictionalproj.supabase.co";
  function stubSampleBackend() {
    for (const [key, value] of Object.entries({
      SAMPLE_SUPABASE_URL: SAMPLE_SUPABASE,
      SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-public-key",
      SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service-key",
    })) vi.stubEnv(key, value);
  }
  function stubSampleScanner() {
    for (const [key, value] of Object.entries({
      SAMPLE_PRIVATE_FILE_SCANNER_HOST: "scanner.example.invalid", SAMPLE_PRIVATE_FILE_SCANNER_PORT: "8444",
      SAMPLE_PRIVATE_FILE_SCANNER_CA: "synthetic-ca", SAMPLE_PRIVATE_FILE_SCANNER_CERT: "sample-client-cert",
      SAMPLE_PRIVATE_FILE_SCANNER_KEY: "sample-client-key",
      SAMPLE_PRIVATE_FILE_SCANNER_EXPECTED_SPKI: "OVEdIiR2/Nn5dSKQFZlJ8sQtCnfYZGHxna0gdgzuW8c=",
      SAMPLE_PRIVATE_FILE_SCANNER_ENGINE_MIN: "1.5.4",
    })) vi.stubEnv(key, value);
  }

  it("refuses a SAMPLE-host request even with a complete SAMPLE backend and scanner family, so no SAMPLE client certificate is ever presented", async () => {
    stubSampleBackend();
    stubSampleScanner();
    const res = await call(undefined, { host: SAMPLE_HOST });
    // Union Ground pins no SAMPLE project, so the demo host never resolves a backend.
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ error: "file-check-unavailable" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(scanPrivateFileWithClamd).not.toHaveBeenCalled();
  });

  it("keeps the SaaS host on the production listener when both families are configured", async () => {
    stubSampleBackend();
    stubSampleScanner();
    const res = await call();
    expect(res.code).toBe(200);
    expect(scanPrivateFileWithClamd).toHaveBeenCalledWith(bytes, expect.objectContaining({
      config: expect.objectContaining({ port: 3311, cert: "synthetic-cert", key: "synthetic-key" }),
    }));
  });

  it("leaves the SAMPLE surface at 503 when its twins are unset instead of borrowing production's", async () => {
    stubSampleBackend();
    const res = await call(undefined, { host: SAMPLE_HOST });
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ error: "file-check-unavailable" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(scanPrivateFileWithClamd).not.toHaveBeenCalled();
    // The production surface is unaffected by the absent twin.
    expect((await call()).code).toBe(200);
  });

  it.each(["SAMPLE_PRIVATE_FILE_SCANNER_KEY", "SAMPLE_PRIVATE_FILE_SCANNER_EXPECTED_SPKI", "SAMPLE_PRIVATE_FILE_SCANNER_PORT"])(
    "stays unavailable on the SAMPLE surface when %s is blank", async (name) => {
      stubSampleBackend();
      stubSampleScanner();
      vi.stubEnv(name, "");
      expect((await call(undefined, { host: SAMPLE_HOST })).code).toBe(503);
      expect(global.fetch).not.toHaveBeenCalled();
      expect((await call()).code).toBe(200);
    },
  );
});
