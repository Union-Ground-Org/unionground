// @vitest-environment node
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/knowledge-ingest.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = body || ""; },
  };
}

function rpcResponse(payload) {
  const body = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => body };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("knowledge ingest API", () => {
  // Union Ground has no CBA ingest. A
  // document filed under the contract category is chunked for search like any
  // other, and the inert contract-article draft writer is never called.
  it("indexes a contract-category document without minting contract-article drafts", async () => {
    const bytes = Buffer.from("ARTICLE I Recognition\nThe employer recognizes the unit.\nARTICLE II Hours\nSchedules post Friday.");
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).includes("authorize_private_upload_inspection")) {
        return rpcResponse({ fileId: FILE_ID, current: true });
      }
      if (String(url).includes("authorize_knowledge_ingest")) {
        return rpcResponse({
          organizationId: "organization-1",
          actorUserId: "actor-1",
          chapterId: "harbor-campaign",
          fileId: FILE_ID,
          bucketId: "knowledge",
          objectName: "organization-1/agreement.txt",
          fileName: "agreement.txt",
          mimeType: "text/plain",
          byteSize: bytes.length,
          contentSha256: null,
          category: "contract",
        });
      }
      if (String(url).includes("/storage/v1/object/authenticated/")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
      if (String(url).includes("record_knowledge_conversion")) {
        return rpcResponse({ id: "33333333-3333-4333-8333-333333333333", attempt: 1, changeKind: "initial", outcome: "succeeded" });
      }
      if (String(url).includes("replace_knowledge_source_chunks")) {
        return rpcResponse({ id: SOURCE_ID, status: "healthy", chunkCount: 1 });
      }
      throw new Error(`unexpected request: ${url} ${options.method || "GET"}`);
    }));

    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer member-access-token", host: "localhost:5173" },
      body: { sourceId: SOURCE_ID },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ source: { id: SOURCE_ID, status: "healthy", chunkCount: 1 } });
    const urls = global.fetch.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes("replace_knowledge_source_chunks"))).toHaveLength(1);
    expect(urls.some((url) => /cba/i.test(url))).toBe(false);
    const chunkCall = global.fetch.mock.calls.find(([url]) => String(url).includes("replace_knowledge_source_chunks"));
    expect(JSON.parse(chunkCall[1].body).p_chunks.join(" ")).toContain("The employer recognizes the unit.");
    const provenance = global.fetch.mock.calls.find(([url]) => String(url).includes("record_knowledge_conversion"));
    expect(JSON.parse(provenance[1].body).p_conversion.metadata).not.toHaveProperty("articleCount");
  });

  it("records a failed source when extraction exhausts the operation deadline", async () => {
    const bytes = Buffer.from("Extractable policy text.");
    const activeSignal = new AbortController().signal;
    const expiredSignal = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
    vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(activeSignal) // authorization RPC
      .mockReturnValueOnce(activeSignal) // pre-download verdict re-check
      .mockReturnValueOnce(activeSignal) // storage download
      .mockReturnValueOnce(expiredSignal) // extraction
      .mockReturnValue(activeSignal); // failure-state cleanup RPC

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (String(url).includes("authorize_private_upload_inspection")) {
        return rpcResponse({ fileId: FILE_ID, current: true });
      }
      if (String(url).includes("authorize_knowledge_ingest")) {
        return rpcResponse({
          organizationId: "organization-1",
          actorUserId: "actor-1",
          fileId: FILE_ID,
          bucketId: "knowledge",
          objectName: "organization-1/source.txt",
          fileName: "source.txt",
          mimeType: "text/plain",
          byteSize: bytes.length,
          contentSha256: null,
          category: "policy",
        });
      }
      if (String(url).includes("/storage/v1/object/authenticated/")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
      if (String(url).includes("record_knowledge_conversion")) {
        return rpcResponse({ id: "33333333-3333-4333-8333-333333333333", attempt: 1, changeKind: "initial", outcome: "failed" });
      }
      if (String(url).includes("replace_knowledge_source_chunks")) {
        return rpcResponse({ id: SOURCE_ID, status: "failed" });
      }
      throw new Error(`unexpected request: ${url} ${options.method || "GET"}`);
    }));

    const response = responseRecorder();
    await handler({
      method: "POST",
      headers: {
        authorization: "Bearer member-access-token",
        host: "app.example.org",
      },
      body: { sourceId: SOURCE_ID },
    }, response);

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: "knowledge-ingest-time-budget" });
    const cleanupCalls = global.fetch.mock.calls.filter(([url]) => (
      String(url).includes("replace_knowledge_source_chunks")
    ));
    expect(cleanupCalls).toHaveLength(1);
    expect(JSON.parse(cleanupCalls[0][1].body)).toMatchObject({
      p_source_id: SOURCE_ID,
      p_chunks: [],
      p_error_code: "knowledge-ingest-time-budget",
    });
    // REQ-UG-DOCUMENT-CONVERSION-PROVENANCE. "This converter, at this
    // version, could not read these bytes" is the answer an operator would
    // otherwise have to guess at, so a failed conversion is recorded exactly
    // like a successful one — with the digest of what was actually downloaded.
    const provenanceCalls = global.fetch.mock.calls.filter(([url]) => (
      String(url).includes("record_knowledge_conversion")
    ));
    expect(provenanceCalls).toHaveLength(1);
    expect(JSON.parse(provenanceCalls[0][1].body).p_conversion).toMatchObject({
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceFormat: "txt",
      converterName: "union-ground-text",
      outcome: "failed",
      errorCode: "knowledge-ingest-time-budget",
      metadata: {},
    });
  });

  // THE VERDICT IS RE-ESTABLISHED IMMEDIATELY BEFORE THE PRIVILEGED READ.
  //
  // `authorize_knowledge_ingest` checks the ledger and then hands back a bucket
  // and an object name this handler reads with the SERVICE ROLE — the one path
  // where knowledge bytes leave Storage without the restrictive quarantine
  // policy being evaluated. The completion RPCs re-read the verdict under the
  // owning storage row lock, so nothing is INDEXED on a lapsed verdict; this
  // closes the other end, so nothing is DOWNLOADED and EXTRACTED on one.
  describe("pre-download verdict re-check", () => {
    function backend({ verdict, onFetch = () => {} }) {
      return vi.fn(async (url, options = {}) => {
        onFetch(String(url), options);
        if (String(url).includes("authorize_private_upload_inspection")) {
          return typeof verdict === "function" ? verdict() : rpcResponse(verdict);
        }
        if (String(url).includes("authorize_knowledge_ingest")) {
          return rpcResponse({
            organizationId: "organization-1",
            actorUserId: "actor-1",
            fileId: FILE_ID,
            bucketId: "organization-knowledge",
            objectName: "organization-1/source.txt",
            fileName: "source.txt",
            mimeType: "text/plain",
            byteSize: 8,
            contentSha256: null,
            category: "policy",
          });
        }
        if (String(url).includes("replace_knowledge_source_chunks")) {
          return rpcResponse({ id: SOURCE_ID, status: "failed" });
        }
        throw new Error(`unexpected request: ${url} ${options.method || "GET"}`);
      });
    }

    async function ingest(fetchImpl) {
      vi.stubGlobal("fetch", fetchImpl);
      const response = responseRecorder();
      await handler({
        method: "POST",
        headers: { authorization: "Bearer member-access-token", host: "app.example.org" },
        body: { sourceId: SOURCE_ID },
      }, response);
      return response;
    }

    it.each([
      ["a lapsed verdict", { fileId: FILE_ID, current: false }, "knowledge-file-inspection-required"],
      ["a lease another inspection holds", { busy: true }, "knowledge-file-inspection-required"],
      ["a quota refusal", { rateLimited: true }, "knowledge-file-inspection-required"],
      ["a stale session", { reauthRequired: true }, "knowledge-file-inspection-required"],
      ["an answer about another file", { fileId: SOURCE_ID, current: true }, "knowledge-file-inspection-required"],
      ["a re-check the server could not answer", () => ({ ok: false, status: 503 }), "knowledge-verdict-unavailable"],
    ])("never downloads the object with the service role on %s", async (_label, verdict, code) => {
      const seen = [];
      const response = await ingest(backend({ verdict, onFetch: (url) => seen.push(url) }));

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body)).toEqual({ error: code });
      // The privileged read never happened, and neither completion RPC ran.
      expect(seen.some((url) => url.includes("/storage/v1/object/"))).toBe(false);
      expect(seen.some((url) => url.includes("replace_cba_knowledge_drafts"))).toBe(false);
      // One best-effort attempt to record the outcome, and only one. Whether it
      // lands is the completion RPC's decision, not this handler's — see below.
      const cleanup = seen.filter((url) => url.includes("replace_knowledge_source_chunks"));
      expect(cleanup).toHaveLength(1);
    });

    // WHAT THE CLEANUP ACTUALLY DOES ON A LAPSED VERDICT.
    //
    // `replace_knowledge_source_chunks` re-reads
    // `private.knowledge_source_object_verdict_locked` before it writes
    // anything, so the very condition that stopped the extraction ALSO refuses
    // the write that would mark the source failed: 42501 -> PostgREST 403. The
    // handler swallows it, the source keeps its previous health and chunks, and
    // only the 422 reaches the caller. That is the gate working — no
    // service-role write touches a source whose file is no longer cleanly
    // inspected — and the read-path gates deny retrieval on the same predicate,
    // so nothing is served from a source left `healthy` with a lapsed verdict.
    it("still answers 422 when the failure-marking write is refused by the same gate", async () => {
      const seen = [];
      const response = await ingest(vi.fn(async (url, options = {}) => {
        seen.push(String(url));
        if (String(url).includes("authorize_private_upload_inspection")) {
          return rpcResponse({ fileId: FILE_ID, current: false });
        }
        if (String(url).includes("authorize_knowledge_ingest")) {
          return rpcResponse({
            organizationId: "organization-1",
            actorUserId: "actor-1",
            fileId: FILE_ID,
            bucketId: "organization-knowledge",
            objectName: "organization-1/source.txt",
            fileName: "source.txt",
            mimeType: "text/plain",
            byteSize: 8,
            contentSha256: null,
            category: "policy",
          });
        }
        if (String(url).includes("replace_knowledge_source_chunks")) {
          // The locked-verdict recheck inside the RPC: 42501 as a 403.
          return { ok: false, status: 403, text: async () => JSON.stringify({ code: "42501", message: "file inspection required" }) };
        }
        throw new Error(`unexpected request: ${url} ${options.method || "GET"}`);
      }));

      // The refusal reaches the caller intact; the swallowed 403 does not
      // become a 500 or overwrite the reason the extraction stopped.
      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body)).toEqual({ error: "knowledge-file-inspection-required" });
      // Attempted once, refused, and never retried.
      expect(seen.filter((url) => url.includes("replace_knowledge_source_chunks"))).toHaveLength(1);
      expect(seen.some((url) => url.includes("/storage/v1/object/"))).toBe(false);
    });

    it("asks the ledger with the caller's own JWT and never names a path", async () => {
      const calls = [];
      await ingest(backend({
        verdict: { fileId: FILE_ID, current: true },
        onFetch: (url, options) => calls.push([url, options]),
      }));
      const [, probe] = calls.find(([url]) => url.includes("authorize_private_upload_inspection"));
      expect(probe.headers.Authorization).toBe("Bearer member-access-token");
      // Exactly {kind, fileId}: no bucket, no object name, no digest, no verdict.
      expect(JSON.parse(probe.body)).toEqual({ p_kind: "knowledge", p_file_id: FILE_ID });
      // And it runs before the service-role read, not after it.
      const probeIndex = calls.findIndex(([url]) => url.includes("authorize_private_upload_inspection"));
      const downloadIndex = calls.findIndex(([url]) => url.includes("/storage/v1/object/"));
      expect(probeIndex).toBeGreaterThanOrEqual(0);
      expect(downloadIndex).toBeGreaterThan(probeIndex);
    });
  });
});
