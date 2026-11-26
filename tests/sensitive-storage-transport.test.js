// @vitest-environment node
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { createSensitiveStorage } from "../api/_lib/sensitiveStorage.js";
import { openSensitiveWindow } from "../scripts/sensitive-data-rollout.mjs";
import { maintainSensitiveDocuments } from "../scripts/sensitive-document-maintenance.mjs";

const origin = "http://127.0.0.1:59999";
const absent = { code: "NoSuchKey", message: "Object not found", statusCode: "404" };
// Independently observed from both hosted project origins on 2026-09-07.
const hostedAbsent = { ...absent, error: "not_found" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fixtures = [
  ["HTML 404 with misleading statusText", () => new Response("<html>upstream failed</html>", { status: 404, statusText: "Object not found", headers: { "content-type": "text/html" } })],
  ["message-only JSON 404", () => json(404, { message: "Object not found" })],
  ["truncated JSON 404", () => new Response('{"code":"NoSuchKey","message":"Object not found"', { status: 404, headers: { "content-type": "application/json" } })],
  ["empty HTTP 200", () => new Response("")],
  ["503 object-not-found text", () => new Response("Object not found", { status: 503 })],
  ...[400,401,403,429,500,503].map((status) => [`HTTP ${status} with absence body`, () => json(status, absent)]),
  ["status/body mismatch", () => json(404, { ...absent, statusCode: "503" })],
  ["conflicting error code", () => json(404, { ...absent, error: "NoSuchBucket" })],
  ["missing bucket", () => json(404, { code: "NoSuchBucket", message: "Bucket not found" })],
  ["oversized body", () => json(404, { ...absent, extra: "x".repeat(4096) })],
  ["HTML mislabeled JSON", () => new Response("<html>bad</html>", { status: 404, headers: { "content-type": "application/json" } })],
  ["timeout", () => { throw new DOMException("Synthetic timeout", "TimeoutError"); }],
  ["broken body stream", () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic truncated transport")); } }), { status: 404, headers: { "content-type": "application/json" } })],
  ["genuine structured absence", () => json(404, absent), true],
  ["hosted structured HTTP 400 absence", () => json(400, hostedAbsent), true],
  ["hosted numeric semantic status", () => json(400, { ...hostedAbsent, statusCode: 404 }), true],
  ["legacy HTTP 400 missing typed code", () => json(400, { statusCode: "404", error: "not_found", message: "Object not found" })],
  ["hosted HTTP 400 missing semantic status", () => json(400, { code: "NoSuchKey", error: "not_found", message: "Object not found" })],
  ["hosted HTTP 400 conflicting status", () => json(400, { ...hostedAbsent, status: 400 })],
  ["hosted HTTP 400 conflicting http status", () => json(400, { ...hostedAbsent, httpStatusCode: 503 })],
  ["hosted HTTP 400 wrong error", () => json(400, { ...hostedAbsent, error: "AccessDenied" })],
  ["hosted HTTP 400 wrong code", () => json(400, { ...hostedAbsent, code: "NoSuchBucket" })],
  ["hosted HTTP 400 message-only", () => json(400, { message: "Object not found" })],
  ["hosted HTTP 400 oversized", () => json(400, { ...hostedAbsent, extra: "x".repeat(4096) })],
  ["hosted HTTP 400 malformed JSON", () => new Response("<html>Object not found</html>", { status: 400, headers: { "content-type": "application/json" } })],
];
function probe(retirement) {
  const row = { id: randomUUID(), object_name: "synthetic-legacy", confirmed_at: null, encrypted_content: null };
  let retired = false;
  return { query: vi.fn(async (sql, args = []) => {
    if (sql.includes("as closed")) return { rows: [{ closed: true, exposed: false }] };
    if (sql.includes("to_regclass")) return { rows: [{ installed: false, form_schema: false }] };
    if (sql.includes("select f.*")) return { rows: !retirement && args[0] < row.id ? [row] : [] };
    if (sql.startsWith("delete from private.sensitive_retired_objects")) retired = true;
    if (sql.startsWith("select object_name")) return { rows: retired ? [] : [{ object_name: row.object_name }] };
    if (sql.includes("count(*)")) return { rows: [{ n: 0 }] };
    return { rows: [] };
  }) };
}
it("reproduces the installed SDK's HTML-to-object-not-found normalization", async () => {
  const storage = createClient(origin, "synthetic-key", { auth: { persistSession: false }, global: { fetch: fixtures[0][1] } }).storage.from("case-files");
  const result = await storage.download("synthetic-legacy");
  expect(result.error).toMatchObject({ status: 404, statusCode: "404", message: "Object not found" });
});
for (const retirement of [false, true]) {
  it.each(fixtures)(`${retirement ? "retirement" : "window restoration"} uses raw transport proof: %s`, async (_name, reply, allowed = false) => {
    const client = probe(retirement);
    const fetcher = vi.fn(async (_url, init) => init.method === "DELETE" ? json(200, []) : reply());
    const storage = createSensitiveStorage(origin, "synthetic-key", { fetch: fetcher });
    const run = retirement ? maintainSensitiveDocuments(client, storage, { ring: {} }) : openSensitiveWindow(client, storage, { ring: {} });
    if (allowed) await run;
    else await expect(run).rejects.toThrow("sensitive-document-storage-unavailable");
    const mutation = retirement ? "delete from private.sensitive_retired_objects" : "do $restore$";
    expect(client.query.mock.calls.some(([sql]) => sql.includes(mutation))).toBe(allowed);
    expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname === "/storage/v1/object/case-files/synthetic-legacy")).toBe(true);
  });
}
it("keeps concurrent SDK downloads' provenance isolated and never caches absence", async () => {
  let calls = 0;
  const storage = createSensitiveStorage(origin, "synthetic-key", { fetch: async (url) => {
    calls += 1;
    return url.endsWith("absent") && calls === 1 ? json(404, absent) : fixtures[0][1]();
  } });
  const [missing, malformed] = await Promise.all([storage.download("absent"), storage.download("malformed")]);
  expect(missing.failure).toBe("absent"); expect(malformed.failure).toBe("unavailable");
  expect((await storage.download("absent")).failure).toBe("unavailable");
});

// The handler uses the real SDK for both caller RLS and Storage. Only the HTTP
// boundary is controlled; no hosted request or plaintext fixture is returned.
vi.mock("../api/_lib/backend.js", () => ({ resolveSupabaseBackend: () => ({ url: "http://127.0.0.1:59999", publishableKey: "synthetic-key", serviceRoleKey: "synthetic-service", surface: "saas" }) }));
it.each(fixtures)("handler never offers recheck based on SDK normalization: %s", async (_name, reply, allowed = false) => {
  const { default: handler } = await import("../api/sensitive-case-files.js");
  const file = randomUUID(); let verdictQueries = 0;
  vi.stubEnv("SENSITIVE_DATA_KEYS", JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64") }));
  vi.stubEnv("SENSITIVE_DATA_ACTIVE_KEY", "v1");
  vi.stubGlobal("fetch", async (url) => {
    const path = new URL(url).pathname;
    if (path === "/rest/v1/member_case_files") return json(200, { id: file, object_name: "synthetic-legacy" });
    if (path === "/rest/v1/rpc/sensitive_case_read_current") { verdictQueries += 1; return json(200, false); }
    if (path === "/storage/v1/object/case-files/synthetic-legacy") return reply();
    throw new Error("unexpected-synthetic-request");
  });
  const response = { status(code) { this.code = code; return this; }, setHeader() { return this; }, end(body) { this.body = JSON.parse(body); } };
  try {
    await handler({ method: "POST", headers: { host: "app.example.org", authorization: "Bearer synthetic-token" }, body: { action: "read", fileId: file } }, response);
    expect(response.code).toBe(allowed ? 409 : 503);
    expect(response.body).toEqual({ error: allowed ? "file-recheck-required" : "sensitive-document-unavailable" });
    expect(verdictQueries).toBe(allowed ? 1 : 0);
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});
it.each([false,true,null])("requires caller SQL false after raw structured AccessDenied (%s)", async (current) => {
  const { default: handler } = await import("../api/sensitive-case-files.js");
  vi.stubEnv("SENSITIVE_DATA_KEYS", JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64") }));
  vi.stubEnv("SENSITIVE_DATA_ACTIVE_KEY", "v1");
  vi.stubGlobal("fetch", async (url) => {
    const path = new URL(url).pathname;
    if (path === "/rest/v1/member_case_files") return json(200, { id: randomUUID(), object_name: "synthetic-legacy" });
    if (path === "/rest/v1/rpc/sensitive_case_read_current") return json(200, current);
    return json(403, { code: "AccessDenied", message: "Access denied" });
  });
  const response = { status(code) { this.code = code; return this; }, setHeader() { return this; }, end() {} };
  try {
    await handler({ method: "POST", headers: { host: "app.example.org", authorization: "Bearer synthetic-token" }, body: { action: "read", fileId: randomUUID() } }, response);
    expect(response.code).toBe(current === false ? 409 : 503);
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});
it.each(["case-files", "member-form-files"])("round-trips %s byte transport and forwards upload/removal with caller credentials", async (bucket) => {
  const bytes = Buffer.from([87, 22, 193, 241]);
  const fetcher = vi.fn(async (_url, init) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-caller");
    expect(new URL(_url).pathname).toContain(`/object/${bucket}`);
    if (init.method === "POST") return json(200, { Id: randomUUID(), Key: "case-files/synthetic" });
    if (init.method === "DELETE") return json(200, []);
    expect(init.redirect).toBe("error"); expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return new Response(bytes);
  });
  const storage = createSensitiveStorage(origin, "synthetic-key", { token: "synthetic-caller", fetch: fetcher, bucket });
  expect((await storage.upload("synthetic", bytes, { contentType: "application/octet-stream", upsert: false })).error).toBeNull();
  const result = await storage.download("synthetic");
  expect(result.error).toBeNull();
  expect(Buffer.from(await result.data.arrayBuffer())).toEqual(bytes);
  expect(result).not.toHaveProperty("failure");
  expect((await storage.remove(["synthetic"])).error).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("refuses buckets outside the encrypted case and form transports before I/O", () => {
  const fetcher = vi.fn();
  expect(() => createSensitiveStorage(origin, "synthetic-key", { bucket: "chapter-documents", fetch: fetcher }))
    .toThrow("sensitive-storage-bucket-refused");
  expect(fetcher).not.toHaveBeenCalled();
});
