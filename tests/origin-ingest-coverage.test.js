// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import knowledge from "../api/knowledge-ingest.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const SOURCE = "10000000-0000-4000-8000-000000000001";
const KNOWLEDGE_FILE = "10000000-0000-4000-8000-000000000002";
const headers = { host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer member-token" };
const content = "Article 1 - Working hours\nEmployees receive a regular schedule and advance notice of changes.\nArticle 2 - Leave\nEmployees may request leave through their supervisor.";
const bytes = Buffer.from(content);
const digest = value => createHash("sha256").update(value).digest("hex");
const target = { fileId: KNOWLEDGE_FILE, organizationId: "org-test", actorUserId: "actor-test", chapterId: "chapter-test", bucketId: "knowledge", objectName: "org-test/policy space.txt", fileName: "policy.txt", mimeType: "text/plain", byteSize: bytes.length, contentSha256: digest(bytes), category: "policy", expectedUpdatedAt: "2026-09-04T00:00:00Z" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function run(handler, extra = {}) {
  const res = { status(code) { this.code = code; return this; }, setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handler({ method: "POST", headers, body: { sourceId: SOURCE, mode: "ingest" }, ...extra }, res);
  return { status: res.code, body: res.body };
}
function upstream(overrides = {}) {
  // The privileged download is the one path where knowledge bytes leave Storage
  // without the restrictive quarantine policy being evaluated, so the handler
  // re-establishes the ledger verdict with the caller's own JWT immediately
  // before it. An already-current object short-circuits inside that RPC before
  // the attempt lease and the hourly quota are touched.
  const routes = { authorize_knowledge_ingest: target,
    authorize_private_upload_inspection: { fileId: KNOWLEDGE_FILE, current: true },
    replace_knowledge_source_chunks: { id: SOURCE, chunkCount: 1 },
    record_knowledge_conversion: { id: "30000000-0000-4000-8000-000000000003", sourceId: SOURCE, attempt: 1, changeKind: "initial", outcome: "succeeded" },
    // Stubbed so a regression that calls the inert CBA draft writer is caught
    // below rather than failing on an unknown route.
    replace_cba_knowledge_drafts: { articleCount: 2, preservedPublishedCount: 1, stagedPublishedCount: 1 },
    storage: () => new Response(bytes), ...overrides };
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const key = url.includes("/rpc/") ? url.split("/rpc/")[1] : url.includes("/storage/") ? "storage" : "external";
    calls.push({ key, url, init, body: init.body ? JSON.parse(init.body) : null });
    const result = typeof routes[key] === "function" ? routes[key](calls) : routes[key];
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : reply(result);
  }));
  return calls;
}
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://psgfictionalproject.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "psgfictionalproject");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
for (const [name, handler, authRpc] of [["knowledge", knowledge, "authorize_knowledge_ingest"]]) {
  describe(`${name} authorization gates`, () => {
    it.each([
      ["origin", { headers: { ...headers, origin: "https://attacker.test" } }, 403, "untrusted-origin"],
      ["method", { method: "GET" }, 405, "method not allowed"],
      ["missing bearer", { headers: { ...headers, authorization: "" } }, 401, "not authorized"],
      ["missing source", { body: {} }, 401, "not authorized"],
    ])("rejects %s without any provider operation", async (_, extra, status, error) => {
      upstream();
      expect(await run(handler, extra)).toEqual({ status, body: { error } });
      expect(fetch).not.toHaveBeenCalled();
    });
    it("requires backend configuration", async () => {
      upstream(); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      expect(await run(handler)).toEqual({ status: 503, body: { error: "not configured" } });
      expect(fetch).not.toHaveBeenCalled();
    });
    it.each([reply({}, 403), new Error("network")])("does not download when authorization fails", async authorization => {
      const calls = upstream({ [authRpc]: authorization });
      expect(await run(handler)).toEqual({ status: 403, body: { error: "not authorized" } });
      expect(calls.map(c => c.key)).toEqual([authRpc]);
    });
    it("honors database ingestion rate limits", async () => {
      const calls = upstream({ [authRpc]: { rateLimited: true } });
      expect((await run(handler)).status).toBe(429);
      expect(calls.map(c => c.key)).toEqual([authRpc]);
    });
  });
}
describe("knowledge ingestion", () => {
  it.each(["policy", "contract"])("downloads, verifies and stores a %s using scoped credentials", async category => {
    const calls = upstream({ authorize_knowledge_ingest: { ...target, category } });
    // Union Ground has no CBA ingest: a
    // contract-category document is stored exactly like a policy, with no
    // contract-article draft counts.
    expect(await run(knowledge)).toEqual({ status: 200, body: { source: { id: SOURCE, chunkCount: 1 } } });
    expect(calls[0].init.headers.Authorization).toBe("Bearer member-token");
    // The verdict re-check runs on the caller's JWT, carries nothing but
    // {kind, fileId}, and comes BEFORE the service-role read.
    expect(calls[1].key).toBe("authorize_private_upload_inspection");
    expect(calls[1].init.headers.Authorization).toBe("Bearer member-token");
    expect(calls[1].body).toEqual({ p_kind: "knowledge", p_file_id: KNOWLEDGE_FILE });
    expect(calls[2].url).toBe("https://psgfictionalproject.supabase.co/storage/v1/object/authenticated/knowledge/org-test/policy%20space.txt");
    expect(calls[2].init.headers.apikey).toBe("sb_secret_test");
    const stored = calls.find(c => c.key === "replace_knowledge_source_chunks");
    expect(stored.body).toEqual({ p_organization_id: target.organizationId, p_source_id: SOURCE, p_actor_user_id: target.actorUserId, p_chunks: [content], p_error_code: null });
    // REQ-UG-DOCUMENT-CONVERSION-PROVENANCE. Provenance is written BEFORE
    // the content it explains, so indexed grounding text can never exist with no
    // record of which bytes and which converter produced it.
    const provenance = calls.find(c => c.key === "record_knowledge_conversion");
    expect(calls.indexOf(provenance)).toBeLessThan(calls.indexOf(stored));
    expect(provenance.body).toMatchObject({
      p_organization_id: target.organizationId,
      p_source_id: SOURCE,
      p_actor_user_id: target.actorUserId,
      p_conversion: {
        sourceSha256: digest(bytes),
        sourceByteSize: bytes.length,
        sourceFormat: "txt",
        converterName: "union-ground-text",
        converterVersion: "1",
        outcome: "succeeded",
      },
    });
    // The digest recorded is the one computed from the bytes that arrived, and
    // the metadata is counters only — never an extract of the document.
    expect(Object.values(provenance.body.p_conversion.metadata).every(value => typeof value === "number")).toBe(true);
    expect(provenance.body.p_conversion).not.toHaveProperty("changeKind");
    expect(provenance.body.p_conversion).not.toHaveProperty("attempt");
    expect(provenance.body.p_conversion.metadata).not.toHaveProperty("articleCount");
    expect(calls.filter(c => c.key === "replace_cba_knowledge_drafts")).toEqual([]);
    expect(calls.map(c => c.key)).toEqual(["authorize_knowledge_ingest", "authorize_private_upload_inspection", "storage", "record_knowledge_conversion", "replace_knowledge_source_chunks"]);
  });
  // THE ROLLOUT WINDOW: CODE DEPLOYED AHEAD OF THE MIGRATION.
  //
  // `public.record_knowledge_conversion` exists only once 20260907110000 is
  // applied hosted, and that apply is a separately sequenced gate. An unguarded
  // provenance write would make every ingest 422 for the whole window, so
  // exactly one error is tolerated — the function is not there yet — and the
  // ingest proceeds with a structured warning an operator can alert on.
  it("completes the ingest and warns when the provenance RPC does not exist yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = upstream({
      record_knowledge_conversion: () => reply({ code: "PGRST202", message: "Could not find the function public.record_knowledge_conversion" }, 404),
    });

    expect(await run(knowledge)).toEqual({ status: 200, body: { source: { id: SOURCE, chunkCount: 1 } } });
    // Attempted once, before the chunk write, and not retried.
    const provenance = calls.filter(c => c.key === "record_knowledge_conversion");
    const stored = calls.filter(c => c.key === "replace_knowledge_source_chunks");
    expect(provenance).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(calls.indexOf(provenance[0])).toBeLessThan(calls.indexOf(stored[0]));
    // The content write is the real one, not the failure cleanup.
    expect(stored[0].body.p_error_code).toBe(null);
    expect(stored[0].body.p_chunks).toEqual([content]);
    // The warning is structured, names the migration to apply, and carries no
    // organization, source, actor or file identity.
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = JSON.parse(warn.mock.calls[0][0]);
    expect(warning).toMatchObject({
      event: "knowledge-conversion-provenance-unavailable",
      rpc: "record_knowledge_conversion",
      status: 404,
      code: "PGRST202",
      migration: "20260907110000_knowledge_conversion_provenance",
    });
    for (const value of Object.values(warning)) {
      expect(String(value)).not.toContain(SOURCE);
      expect(String(value)).not.toContain(target.organizationId);
      expect(String(value)).not.toContain(target.actorUserId);
    }
  });

  it("does not append a failed outcome after provenance succeeds but chunk storage fails", async () => {
    const calls = upstream({
      replace_knowledge_source_chunks: (seen) => {
        if (seen.some((call) => call.key === "record_knowledge_conversion")) {
          return new Error("chunk-write-failed-after-provenance");
        }
        return { id: SOURCE, chunkCount: 1 };
      },
    });

    expect(await run(knowledge)).toEqual({ status: 422, body: { error: "knowledge-ingest-failed" } });
    const provenance = calls.filter((call) => call.key === "record_knowledge_conversion");
    expect(provenance).toHaveLength(1);
    expect(provenance[0].body.p_conversion.outcome).toBe("succeeded");
  });

  it("does not treat an internal undefined-function error as a missing RPC", async () => {
    const calls = upstream({
      record_knowledge_conversion: () => Object.assign(new Error("missing helper inside existing RPC"), {
        status: 404,
        code: "42883",
      }),
    });

    expect(await run(knowledge)).toEqual({ status: 422, body: { error: "knowledge-ingest-failed" } });
    expect(calls.filter((call) => call.key === "replace_knowledge_source_chunks")).toHaveLength(1);
  });

  // AND THE TOLERANCE IS EXACTLY THAT NARROW.
  //
  // Once the function exists, provenance-before-content holds in full: any
  // other refusal stops the ingest before a chunk is written, so indexed
  // grounding text can never exist with no record of where it came from.
  it.each([
    ["a refusal", () => reply({ code: "42501", message: "permission denied" }, 403)],
    ["a server failure", () => reply({ code: "XX000", message: "internal error" }, 500)],
    ["a 404 that is not a missing function", () => reply({ code: "PGRST116", message: "no rows" }, 404)],
    ["a 400 SQLSTATE from an existing function", () => reply({ code: "42883", message: "function body failed" }, 400)],
  ])("refuses to index content when the provenance write fails with %s", async (_label, record_knowledge_conversion) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = upstream({ record_knowledge_conversion });

    expect(await run(knowledge)).toEqual({ status: 422, body: { error: "knowledge-ingest-failed" } });
    // Nothing was indexed: the only chunk write is the failure cleanup.
    expect(calls.filter(c => c.key === "replace_knowledge_source_chunks").map(c => c.body.p_chunks)).toEqual([[]]);
    expect(calls.some(c => c.key === "replace_cba_knowledge_drafts")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["download", { storage: () => reply({}, 503) }, "knowledge-storage-download-failed"],
    ["size", { authorize_knowledge_ingest: { ...target, byteSize: 1 } }, "knowledge-storage-size-mismatch"],
    ["digest", { authorize_knowledge_ingest: { ...target, contentSha256: "b".repeat(64) } }, "knowledge-storage-digest-mismatch"],
  ])("records a failed source after %s failure without storing untrusted content", async (_, overrides, error) => {
    const calls = upstream(overrides);
    expect(await run(knowledge)).toEqual({ status: 422, body: { error } });
    expect(calls.filter(c => c.key === "replace_knowledge_source_chunks").map(c => c.body)).toEqual([{
      p_organization_id: target.organizationId, p_source_id: SOURCE, p_actor_user_id: target.actorUserId, p_chunks: [], p_error_code: error,
    }]);
    expect(calls.some(c => c.key === "replace_cba_knowledge_drafts")).toBe(false);
    // Nothing was converted, because nothing trustworthy was ever read: the
    // download failed, or the bytes did not match what the authorization
    // promised. Recording a conversion attempt here would invent one.
    expect(calls.some(c => c.key === "record_knowledge_conversion")).toBe(false);
  });

  // A LAPSED VERDICT IS THE ONE FAILURE THAT CANNOT BE RECORDED.
  //
  // The cleanup goes through `replace_knowledge_source_chunks`, which re-reads
  // the locked verdict before it writes anything — so on this path the write
  // that would mark the source failed is refused by the very condition that
  // stopped the extraction. The attempt is still made (one call, right
  // arguments), it is refused (42501 as a 403), the handler swallows it, and
  // the source keeps its previous health and chunks. Fail-closed at read: the
  // read-path gates deny retrieval on the same predicate.
  it("refuses the extraction on a lapsed verdict and leaves the source's health as it stands", async () => {
    const calls = upstream({
      authorize_private_upload_inspection: { fileId: KNOWLEDGE_FILE, current: false },
      replace_knowledge_source_chunks: () => reply({ code: "42501", message: "file inspection required" }, 403),
    });
    expect(await run(knowledge)).toEqual({ status: 422, body: { error: "knowledge-file-inspection-required" } });
    expect(calls.some(c => c.url.includes("/storage/v1/object/"))).toBe(false);
    expect(calls.some(c => c.key === "record_knowledge_conversion")).toBe(false);
    expect(calls.filter(c => c.key === "replace_knowledge_source_chunks").map(c => c.body)).toEqual([{
      p_organization_id: target.organizationId, p_source_id: SOURCE, p_actor_user_id: target.actorUserId,
      p_chunks: [], p_error_code: "knowledge-file-inspection-required",
    }]);
    expect(calls.some(c => c.key === "replace_cba_knowledge_drafts")).toBe(false);
  });
});
