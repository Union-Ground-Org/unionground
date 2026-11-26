// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillEmbeddings, chunkBody, embedChunks, parseOptions, permittedEndpoint } from "../scripts/backfill-member-kb-embeddings.mjs";
import { COMPASS_EMBEDDING_MODEL_DIGEST } from "../api/_lib/compassEmbeddings.js";
import { createHash } from "node:crypto";

// Union Ground approves no mesh host (MESH_HOSTS is empty), so shipped code
// can never accept an embedding response. These suites exercise the script's
// own batching, ordering and write accounting against a stand-in host list;
// the first case below pins the shipped, empty behavior. Shipped code never
// sees the stand-in.
const mesh = vi.hoisted(() => ({ approved: ["mesh-host-1"] }));
vi.mock("../api/_lib/compassAiGovernance.js", async (importOriginal) => ({
  ...(await importOriginal()),
  MESH_HOSTS: { includes: (host) => mesh.approved.includes(host) },
}));
beforeEach(() => { mesh.approved = ["mesh-host-1"]; });

const access = { endpoint: "http://127.0.0.1:11440/v1/embeddings", bearer: "synthetic-test-bearer", envTag: "mesh-app" };
const vector = (axis = 0) => Array.from({ length: 1024 }, (_, i) => i === axis ? 1 : 0);
const response = (data, overrides = {}) => ({ ok: true, headers: new Headers({ "x-ug-mesh-host": "mesh-host-1", "x-ug-mesh-model-digest": COMPASS_EMBEDDING_MODEL_DIGEST, "x-ug-mesh-request-id": "backfill-test" }), json: async () => ({ model: "bge-m3", data }), ...overrides });
const body = "The employer shall not discipline or discharge an employee without just cause.";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const classification = { version: "compass-document-v1", status: "ready", rule: "published-document", body_sha256: hash(body), text: body, text_sha256: hash(body), input_sha256: "a".repeat(64) };

describe("Compass embedding backfill", () => {
  it("refuses every embedding batch, and writes nothing, while no mesh host is approved", async () => {
    mesh.approved = [];
    const fetchImplementation = vi.fn(async (_url, options) => {
      expect(options.redirect).toBe("error");
      return response(JSON.parse(options.body).input.map((_, index) => ({ index, embedding: vector(index) })));
    });
    await expect(embedChunks([body], { ...access, fetchImplementation })).rejects.toThrow("embedding proof refused");
    const queries = [];
    const client = { query: vi.fn(async (sql) => {
      queries.push(sql);
      if (sql.startsWith("select a.id, a.body")) return { rows: [{ id: "source", body, body_sha256: "a".repeat(64), compass_classification: classification }] };
      if (sql.startsWith("select count(*)")) return { rows: [{ count: 0 }] };
      return { rowCount: 1, rows: [{ id: "source" }] };
    }) };
    await expect(backfillEmbeddings({ client, dryRun: false, ...access, fetchImplementation })).rejects.toThrow("embedding proof refused");
    expect(queries.some((sql) => sql.startsWith("insert"))).toBe(false);
    expect(queries).not.toContain("commit");
  });

  it("defaults to dry run and rejects ambiguous or unbounded commands", () => {
    expect(parseOptions([])).toEqual({ dryRun: true, pruneOnly: false, limit: 100, after: null });
    expect(parseOptions(["--apply", "--prune-only", "--limit=500"])).toEqual({ dryRun: false, pruneOnly: true, limit: 500, after: null });
    for (const args of [["--apply", "--dry-run"], ["--apply", "--apply"], ["--limit=501"], ["--limit=2", "--limit=3"], ["--force"]]) expect(() => parseOptions(args)).toThrow();
  });

  it("accepts only explicit loopback or tailnet embedding endpoints", () => {
    for (const url of [access.endpoint, "http://100.64.12.34:11440/v1/embeddings", "http://[::1]:11440/v1/embeddings"]) expect(permittedEndpoint(url)).toBe(url);
    for (const url of ["https://api.example.com/v1/embeddings", "http://100.128.0.1/v1/embeddings", `${access.endpoint}?redirect=x`, `${access.endpoint}#x`, "http://secret@localhost/v1/embeddings", "http://localhost/v1/chat/completions"]) expect(permittedEndpoint(url)).toBeNull();
  });

  it("minimizes complete source sentences before making overlapping bounded chunks", () => {
    const chunks = chunkBody(`${body} Marisol Alvarez has lupus and SSN 123-45-6789. ${body.repeat(45)}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
    const serialized = JSON.stringify(chunks);
    expect(serialized).toContain("just cause");
    for (const value of ["Marisol", "lupus", "123-45-6789"]) expect(serialized).not.toContain(value);
    expect(() => chunkBody("Marisol Alvarez has lupus.")).toThrow();
    expect(() => chunkBody(body.repeat(300))).toThrow();
  });

  it("batches embeddings, restores returned index order and refuses redirects", async () => {
    const fetchImplementation = vi.fn(async (_url, options) => {
      const input = JSON.parse(options.body).input;
      expect(options.redirect).toBe("error");
      return response(input.map((_, index) => ({ index, embedding: vector(index) })).reverse());
    });
    const result = await embedChunks(Array(65).fill(body), { ...access, fetchImplementation });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(65);
    expect(result[0]).toEqual(vector(0));
    expect(result[63]).toEqual(vector(63));
    expect(result[64]).toEqual(vector(0));
  });

  it("refuses incomplete, duplicate, zero or unproved batches", async () => {
    for (const reply of [response([]), response([{ index: 1, embedding: vector() }]), response([{ index: 0, embedding: Array(1024).fill(0) }]), response([{ index: 0, embedding: vector() }], { headers: new Headers() })]) {
      await expect(embedChunks([body], { ...access, fetchImplementation: async () => reply })).rejects.toThrow();
    }
    await expect(embedChunks([body, body], { ...access, fetchImplementation: async () => response([{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }]) })).rejects.toThrow(/indexes/);
  });

  it("performs only SELECTs with no mesh call during a dry run and logs counts and an opaque continuation cursor", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ count: 2 }] }).mockResolvedValueOnce({ rows: [{ id: "00000000-0000-4000-8000-000000000001", body, body_sha256: "a".repeat(64), compass_classification: classification }, { id: "00000000-0000-4000-8000-000000000002", body: "Marisol Alvarez has lupus." }] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });
    const log = vi.fn();
    const fetchImplementation = vi.fn();
    const counts = await backfillEmbeddings({ client: { query }, log, ...access, fetchImplementation });
    expect(counts).toMatchObject({ stale: 2, selected: 2, written: 0, chunksWritten: 0, withheld: 1, chunks: 1, indexRows: 0 });
    expect(counts.nextCursor).toBe("00000000-0000-4000-8000-000000000002");
    expect(query.mock.calls.every(([sql]) => /^select /i.test(sql))).toBe(true);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(query.mock.calls.every(([sql]) => sql.includes("private.compass_article_scope_current(a)"))).toBe(true);
    expect(query.mock.calls[0][0]).toContain("e.compass_scope_path=a.compass_scope_path");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-source|Marisol|employer/);
  });

  it("takes the graph gate before the source row and drops an embedding if eligibility changes", async () => {
    const queries = [];
    const client = { query: vi.fn(async (sql) => {
      queries.push(sql);
      if (sql.startsWith("select a.id, a.body")) return { rows: [{ id: "source", body, body_sha256: "a".repeat(64), compass_classification: classification }] };
      if (sql.includes("for update")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("select count(*)")) return { rows: [{ count: 0 }] };
      return { rowCount: 0, rows: [] };
    }) };
    const counts = await backfillEmbeddings({ client, dryRun: false, ...access, fetchImplementation: async () => response([{ index: 0, embedding: vector() }]) });
    expect(counts).toMatchObject({ changed: 1, written: 0, chunksWritten: 0 });
    const begin = queries.indexOf("begin");
    const graphLock = queries.indexOf("select private.lock_case_graph(array[]::uuid[],array[]::uuid[])");
    const sourceLock = queries.findIndex((sql) => sql.includes("for update"));
    // A missing call has index -1 and must fail, rather than satisfy an order
    // comparison. The gate belongs to this transaction and precedes the row.
    expect(begin, "the article write starts a transaction").toBeGreaterThanOrEqual(0);
    expect(graphLock, "the graph gate is acquired after begin").toBeGreaterThan(begin);
    expect(sourceLock, "the source row is locked after the graph gate").toBeGreaterThan(graphLock);
    expect(queries[sourceLock + 1]).toBe("rollback");
    expect(queries).not.toContain("commit");
    expect(queries.some((sql) => sql.startsWith("insert"))).toBe(false);
  });

  it("counts committed chunk rows from the inserts and reports the current index rows", async () => {
    const long = body.repeat(20);
    const longClassification = { ...classification, body_sha256: hash(long), text: long, text_sha256: hash(long) };
    const chunks = chunkBody(long, longClassification);
    expect(chunks.length).toBeGreaterThan(1);
    const writeClient = (insertRowCount) => {
      const queries = [];
      return { queries, query: vi.fn(async (sql) => {
        queries.push(sql);
        if (sql.startsWith("select a.id, a.body")) return { rows: [{ id: "source", body: long, body_sha256: "a".repeat(64), compass_classification: longClassification }] };
        if (sql.includes("for update")) return { rowCount: 1, rows: [{ id: "source" }] };
        if (sql.startsWith("insert into")) return { rowCount: insertRowCount, rows: [] };
        if (sql.startsWith("select count(*)")) return { rows: [{ count: 7 }] };
        return { rowCount: 0, rows: [] };
      }) };
    };
    const fetchImplementation = async (_url, options) => response(JSON.parse(options.body).input.map((_, index) => ({ index, embedding: vector(index) })));
    const client = writeClient(1);
    const counts = await backfillEmbeddings({ client, dryRun: false, ...access, fetchImplementation });
    expect(counts).toMatchObject({ selected: 1, written: 1, chunks: chunks.length, chunksWritten: chunks.length, indexRows: 7 });
    expect(client.queries.indexOf("commit")).toBeGreaterThan(client.queries.findLastIndex((sql) => sql.startsWith("insert into")));

    // An insert that reports no row is not a written row: the replacement rolls
    // back and nothing is credited.
    const short = writeClient(0);
    await expect(backfillEmbeddings({ client: short, dryRun: false, ...access, fetchImplementation })).rejects.toThrow("embedding write refused");
    expect(short.queries).toContain("rollback");
    expect(short.queries).not.toContain("commit");
  });
});
