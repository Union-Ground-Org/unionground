import { decryptInspectedCaseDocument, encryptCaseDocument } from "../api/_lib/sensitiveCaseDocuments.js";
import { MEMBER_SUPPORT_RPCS } from "../src/features/memberSupport/contract.js";
// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import handler from "../api/sensitive-content.js";
import filesHandler from "../api/sensitive-case-files.js";
import { createClient } from "@supabase/supabase-js";
import { encryptSensitive, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
// tests/setup.js already loads the real trusted-backend table through the demo
// data; reset the registry so the transport sees the mocked fictional pair.
vi.resetModules();
const { sensitiveContentRpc, uploadSensitiveCaseFile, downloadSensitiveCaseFile, downloadSensitiveCaseBytes, downloadSensitiveFormBytes, sensitiveApiEndpoint } = await import("../src/lib/sensitiveContentApi.js");
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("../api/_lib/sensitiveStorage.js", () => ({ createSensitiveStorage: (...args) => createClient(...args).storage.from("case-files") }));
const organization = randomUUID(), id = randomUUID();
let rows, result, client;
function response() { return { status(code) { this.code = code; return this; }, setHeader(name, value) { this.headers ??= {}; this.headers[name] = value; return this; }, end(body) { this.body = Buffer.isBuffer(body) ? Buffer.from(body) : JSON.parse(body); } }; }
async function call(body, headers = {}, target = handler, method = "POST") {
  const res = response();
  await target({ method, headers: { host: PORTAL_HOST, authorization: "Bearer caller-token", ...headers }, body }, res);
  return res;
}
beforeEach(() => {
  vi.stubEnv("SENSITIVE_DATA_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
  vi.stubEnv("SENSITIVE_DATA_ACTIVE_KEY", "v1");
  rows = []; result = { id };
  const chain = {};
  for (const name of ["select", "eq", "order", "limit", "in", "gt", "delete"]) chain[name] = vi.fn(() => chain);
  chain.then = (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve);
  chain.single = vi.fn(async () => ({ data: rows[0], error: rows.length ? null : { code: "42501" } }));
  client = { auth: { getUser: vi.fn(async () => ({ data: { user: { id } } })) }, rpc: vi.fn(async (operation) => ({ data: operation === "sensitive_data_organization" ? organization : operation === "stage_sensitive_write" ? id : result, error: null })), from: vi.fn(() => chain) };
  vi.mocked(createClient).mockReturnValue(client);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
it("sends ciphertext to existing caller-authorized RPCs and returns no envelope", async () => {
  const res = await call({ operation: "create_member_accommodation_request", args: { p_idempotency_key: id, p_description: "Synthetic private content", p_request_type: "schedule" } });
  expect(res.code).toBe(200);
  const [name, args] = client.rpc.mock.calls[2];
  expect(name).toBe("write_sensitive_content");
  expect(args.p_arguments.p_description).toBe("[encrypted]");
  expect(JSON.stringify(args)).not.toContain("Synthetic private content");
  expect(createClient.mock.calls[0][2].global.headers.Authorization).toBe("Bearer caller-token");
  expect(res.headers["Cache-Control"]).toBe("no-store");
});
it("decrypts only returned authorized rows and rejects plaintext legacy reads", async () => {
  expect(MEMBER_SUPPORT_RPCS.snapshot).toBe("get_member_support_workspace");
  const row = { id, organization_id: organization, description: "[encrypted]", staff_note: "", encrypted_content: { description: encryptSensitive(Buffer.from("private detail"), { organization, record: id, field: "description", purpose: "member_accommodation_requests" }, sensitiveKeyring()) } };
  rows = [row]; result = { accommodations: [{ id }] };
  const res = await call({ operation: "get_member_support_workspace" });
  expect(res.body.data.accommodations[0].description).toBe("private detail");
  rows = [];
  expect((await call({ operation: "get_member_support_workspace" })).body.data.accommodations[0].contentError).toBe("sensitive-content-unavailable");
  rows = [{ ...row, encrypted_content: {}, description: "legacy plaintext" }];
  expect((await call({ operation: "get_member_support_workspace" })).body.data.accommodations[0].contentError).toBe("sensitive-content-unavailable");
});
it("rejects foreign scope, absent keys, unknown operations and browser origin before disclosure", async () => {
  client.rpc.mockResolvedValue({ error: { message: "denied" } });
  expect((await call({ operation: "list_retaliation", args: { caseId: id } })).code).toBe(403);
  expect((await call({ operation: "arbitrary" })).code).toBe(400);
  expect((await call({}, { origin: "https://foreign.invalid" })).code).toBe(403);
  expect((await call({}, {}, handler, "GET")).code).toBe(405);
  vi.stubEnv("SENSITIVE_DATA_KEYS", "");
  expect((await call({ operation: "get_member_support_workspace" })).body).toEqual({ error: "sensitive-data-key-or-backfill-unavailable" });
});
it("does not log upstream errors or return secret-bearing database failures", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  client.rpc.mockRejectedValue(new Error("synthetic-private-value-and-token"));
  const res = await call({ operation: "get_member_support_workspace" });
  expect(JSON.stringify(res.body)).not.toContain("synthetic-private-value");
  expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
});
it("document endpoint authorizes target before upload and rejects missing metadata on reads", async () => {
  client.rpc.mockResolvedValue({ error: { code: "42501" } });
  expect((await call({ action: "upload", fileId: id, bytes: "dGVzdA==" }, {}, filesHandler)).code).toBe(403);
  expect((await call({ action: "read", fileId: id }, {}, filesHandler)).code).toBe(403);
  expect((await call({ action: "read", fileId: "invalid" }, {}, filesHandler)).code).toBe(400);
  expect((await call({ action: "upload", fileId: id, bytes: "x".repeat(4 * 1024 * 1024 + 1) }, {}, filesHandler)).code).toBe(413);
});
it("web/native transports carry only bearer auth to approved API origins", async () => {
  const transport = { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "synthetic-token" } } })) } };
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ data: { id } }) })); vi.stubGlobal("fetch", fetcher);
  expect((await sensitiveContentRpc(transport, "create_member_accommodation_request", {}, PORTAL_ORIGIN)).data).toEqual({ id });
  expect(fetcher.mock.calls[0][0]).toBe(`${PORTAL_ORIGIN}/api/sensitive-content`);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer synthetic-token");
  expect(() => sensitiveApiEndpoint("/api/sensitive-content", "https://foreign.invalid")).toThrow();
  fetcher.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
  expect((await sensitiveContentRpc(transport, "get_member_support_workspace")).error.code).toBe("SENSITIVE_DATA_UNAVAILABLE");
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ fileId: id, status: "uploaded" }) });
  expect(await uploadSensitiveCaseFile(transport, id, new Blob(["bytes"]))).toEqual({ error: null });
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body)).toEqual({ action: "upload", fileId: id, bytes: "Ynl0ZXM=" });
  fetcher.mockResolvedValue(new Response("bytes", { headers: { "X-Sensitive-Data-Version": id, "X-Sensitive-Total-Bytes": "5", "Content-Type": "text/plain" } }));
  expect(await (await downloadSensitiveCaseFile(transport, id)).text()).toBe("bytes");
  const nativeFetch = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "X-Sensitive-Data-Version": id, "X-Sensitive-Total-Bytes": "2" } }));
  expect(new Uint8Array(await downloadSensitiveCaseBytes(transport, id, PORTAL_ORIGIN, nativeFetch))).toEqual(new Uint8Array([1, 2]));
  expect(nativeFetch.mock.calls.at(-1)[0]).toBe(`${PORTAL_ORIGIN}/api/sensitive-case-files`);
  // A sealed form attachment's bytes, for the phone, read from the form route (#8699).
  expect(new Uint8Array(await downloadSensitiveFormBytes(transport, id, PORTAL_ORIGIN, nativeFetch))).toEqual(new Uint8Array([1, 2]));
  expect(nativeFetch.mock.calls.at(-1)[0]).toBe(`${PORTAL_ORIGIN}/api/sensitive-form-files`);
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: "file-recheck-required" }), { status: 409, headers: { "content-type": "application/json" } }));
  await expect(downloadSensitiveCaseFile(transport, id)).rejects.toMatchObject({ staleVerdict: true });
});
it("uploads only ciphertext, records metadata once, and decrypts a caller-authorized Storage read", async () => {
  const plaintext = Buffer.from("Synthetic grievance evidence");
  const row = { id, organization_id: organization, size_bytes: plaintext.length, object_name: "authorized/path.txt", mime_type: "text/plain", member_cases: { organization_id: organization } };
  let stored;
  client.rpc.mockImplementation(async (operation, args) => {
    if (operation === "sensitive_case_upload_target") return { data: row };
    if (operation === "sensitive_case_inspection_metadata") return { data: row };
    if (operation === "set_sensitive_case_envelope") { row.encrypted_content = args.p_envelope; return { data: true }; }
    return { data: organization };
  });
  const upload = vi.fn(async (_path, bytes) => { stored = Buffer.from(bytes); return { error: null }; });
  const download = vi.fn(async () => ({ data: new Blob([stored]), error: null }));
  client.storage = { from: vi.fn(() => ({ upload, download })) };
  expect((await call({ action: "upload", fileId: id, bytes: plaintext.toString("base64") }, {}, filesHandler)).code).toBe(200);
  expect(stored.equals(plaintext)).toBe(false);
  expect(stored.length).toBe(plaintext.length);
  expect(row.encrypted_content.payload).not.toHaveProperty("ciphertext");
  rows = [row];
  const attemptId = randomUUID();
  expect(await decryptInspectedCaseDocument({ url: "https://test.invalid", serviceRoleKey: "synthetic", surface: "saas" }, { fileId: id, attemptId, objectName: row.object_name }, stored)).toEqual(plaintext);
  expect(client.rpc).toHaveBeenCalledWith("sensitive_case_inspection_metadata", { p_file_id: id, p_attempt_id: attemptId });
  const read = await call({ action: "read", fileId: id }, {}, filesHandler);
  expect(read.code).toBe(200);
  expect(read.body).toEqual(plaintext);
  expect(read.headers["Cache-Control"]).toBe("no-store");
  expect(download).toHaveBeenCalledWith(row.object_name);
  stored[0] ^= 1;
  expect((await call({ action: "read", fileId: id }, {}, filesHandler)).code).toBe(503);
  client.rpc.mockResolvedValue({ data: false });
  expect((await call({ action: "upload", fileId: id, bytes: plaintext.toString("base64") }, {}, filesHandler)).code).toBe(403);
});
it.each(["error", "absent", "file", "path", "ciphertext"])("refuses unavailable or mismatched inspection metadata: %s", async (failure) => {
  const target = { fileId: id, attemptId: randomUUID(), objectName: "synthetic/path" };
  const row = { id, object_name: target.objectName, size_bytes: 4, organization_id: organization, encrypted_content: {} };
  if (failure === "file") row.id = randomUUID();
  if (failure === "path") row.object_name = "synthetic/other";
  client.rpc.mockResolvedValue({ data: failure === "absent" ? null : row, error: failure === "error" ? { code: "42501" } : null });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(decryptInspectedCaseDocument({ url: "https://test.invalid", serviceRoleKey: "synthetic", surface: "saas" }, target, Buffer.from("test")))
    .rejects.toThrow(failure === "ciphertext" ? "sensitive-data-key-or-ciphertext-unavailable" : "sensitive-document-unavailable");
  expect(client.from).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});
it("lists and decrypts retaliation rows using the server-derived organization and rejects malformed or revoked requests", async () => {
  rows = [{ id, organization_id: organization, protected_activity: "[encrypted]", encrypted_content: {
    protected_activity: encryptSensitive(Buffer.from("Synthetic protected activity"), { organization, record: id, field: "protected_activity", purpose: "casework_retaliation_reports" }, sensitiveKeyring()),
  } }];
  const res = await call({ operation: "list_retaliation", args: { caseId: id } });
  expect(res.code).toBe(200);
  expect(res.body.data.reports[0].protected_activity).toBe("Synthetic protected activity");
  expect((await call({ operation: "list_retaliation", args: { caseId: "bad" } })).code).toBe(400);
  expect((await call({ operation: "create_member_accommodation_request", args: { p_description: "" } })).code).toBe(400);
  expect((await call({ operation: "list_retaliation" }, { authorization: "", origin: PORTAL_ORIGIN })).code).toBe(401);
  vi.stubEnv("SENSITIVE_DATA_REVOKED_ORGANIZATIONS", JSON.stringify([organization]));
  expect((await call({ operation: "list_retaliation", args: { caseId: id } })).code).toBe(503);
});
it("document method, authentication and origin failures never start a privileged operation", async () => {
  expect((await call({}, {}, filesHandler, "GET")).code).toBe(405);
  expect((await call({}, { authorization: "", origin: PORTAL_ORIGIN }, filesHandler)).code).toBe(401);
  expect((await call({}, { origin: "https://foreign.invalid" }, filesHandler)).code).toBe(403);
  expect(createClient).not.toHaveBeenCalled();
});

it("isolates corrupt accommodation records and hydrates beyond the PostgREST 1000-row cap", async () => {
  rows = Array.from({ length: 1001 }, () => {
    const record = randomUUID();
    return { id: record, organization_id: organization, description: "[encrypted]", staff_note: "", encrypted_content: { description: encryptSensitive(Buffer.from("Synthetic private detail"), { organization, record, field: "description", purpose: "member_accommodation_requests" }, sensitiveKeyring()) } };
  });
  result = { accommodations: rows.map(({ id }) => ({ id })), unrelated: "available" };
  const chain = client.from();
  let ids;
  chain.in = vi.fn((_column, values) => { ids = values; return chain; });
  chain.then = (resolve) => Promise.resolve({ data: ids ? rows.filter((r) => ids.includes(r.id)) : rows.slice(0,1000), error: null }).then(resolve);
  const large = await call({ operation: "get_member_support_workspace" });
  expect(large.code).toBe(200);
  expect(large.body.data.accommodations[1000].description).toBe("Synthetic private detail");
  rows[0].encrypted_content.description.payload = {};
  const damaged = await call({ operation: "get_member_support_workspace" });
  expect(damaged.code).toBe(200);
  expect(damaged.body.data.unrelated).toBe("available");
  expect(damaged.body.data.accommodations[0]).toMatchObject({ contentError: "sensitive-content-unavailable", description: "Content unavailable", staffNote: "" });
  expect(damaged.body.data.accommodations[1000].description).toBe("Synthetic private detail");
});

it("transports the existing 10 MiB contract as bounded encrypted chunks and bounded reads", async () => {
  const size = 10 * 1024 * 1024;
  const plaintext = Buffer.alloc(size, 97);
  const row = { id, organization_id: organization, size_bytes: size, object_name: "synthetic/chunked.txt", mime_type: "text/plain", member_cases: { organization_id: organization } };
  const chunks = new Map(); let stored;
  const chain = client.from();
  chain.upsert = vi.fn(async (part) => { chunks.set(part.chunk_index,part); return { error: null }; });
  const storage = { upload: vi.fn(async (_path, bytes) => { stored = Buffer.from(bytes); return { error: null }; }), download: vi.fn(async () => ({ data: new Blob([stored]) })) };
  client.storage = { from: () => storage };
  client.from.mockImplementation((table) => {
    if (table === "sensitive_case_chunks") {
      const chunkChain = { ...chain };
      for (const name of ["select","eq","gt","order","delete"]) chunkChain[name] = () => chunkChain;
      chunkChain.then = (resolve) => Promise.resolve({ data: [...chunks.values()].sort((a,b) => a.chunk_index-b.chunk_index) }).then(resolve);
      return chunkChain;
    }
    return chain;
  });
  client.rpc.mockImplementation(async (operation,args) => {
    if (operation === "sensitive_case_upload_target") return { data: row };
    if (operation === "set_sensitive_case_envelope") { row.encrypted_content=args.p_envelope; return { data: true }; }
    return { data: organization };
  });
  const requests = [];
  vi.stubGlobal("fetch",vi.fn(async (_url, init) => {
    expect(init.body.length).toBeLessThan(1500000);
    const body = JSON.parse(init.body); requests.push(body.action);
    const reply = await call(body,{},filesHandler);
    return new Response(Buffer.isBuffer(reply.body) ? reply.body : JSON.stringify(reply.body), { status:reply.code, headers:reply.headers });
  }));
  const transport = { auth: { getSession: async () => ({ data:{session:{access_token:"synthetic-token"}} }) } };
  expect(await uploadSensitiveCaseFile(transport,id,new Blob([plaintext]))).toEqual({error:null});
  expect(requests.filter((x) => x === "chunk")).toHaveLength(10);
  expect(requests.at(-1)).toBe("finish");
  expect(stored.equals(plaintext)).toBe(false);
  expect([...chunks.values()].every((part) => part.envelope.payload.ciphertext !== plaintext.subarray(part.chunk_index * 1024 * 1024,(part.chunk_index + 1) * 1024 * 1024).toString("base64"))).toBe(true);
  rows=[row];
  expect(Buffer.from(await downloadSensitiveCaseBytes(transport,id)).equals(plaintext)).toBe(true);
  expect(requests.filter((x) => x === "read")).toHaveLength(10);
  await expect(uploadSensitiveCaseFile(transport,id,{size:size+1})).rejects.toThrow("10 MiB");
  const savedChunk = chunks.get(0);
  chunks.set(0,{...savedChunk,envelope:{...savedChunk.envelope,purpose:"case-document-chunk-b"}});
  expect((await call({action:"finish",fileId:id},{},filesHandler)).code).toBe(503);
},30000);
it("serves authorized protected pattern labels and routes the staff Scan control through trusted staging", async () => {
  rows = [{ id, organization_id: organization, subject_label: "[encrypted]", encrypted_content: {
    subject_label: encryptSensitive(Buffer.from("Synthetic management label"), { organization, record:id, field:"subject_label", purpose:"casework_retaliation_patterns" }, sensitiveKeyring()),
  } }];
  const read = await call({ operation:"list_patterns",args:{chapterId:"synthetic-chapter"} });
  expect(read.code).toBe(200);
  expect(client.from).toHaveBeenCalledWith("casework_retaliation_patterns");
  const patternQuery = client.from.mock.results[client.from.mock.calls.findIndex(([table]) => table === "casework_retaliation_patterns")].value;
  expect(patternQuery.select).toHaveBeenCalled();
  expect(patternQuery.delete).not.toHaveBeenCalled();
  expect(client.rpc.mock.calls.some(([name]) => name === "write_sensitive_content")).toBe(false);
  expect(read.body.data[0].subject_label).toBe("Synthetic management label");
  expect(read.body.data[0]).not.toHaveProperty("encrypted_content");
  expect((await call({operation:"casework_scan_retaliation_patterns",args:{p_chapter_id:123}})).code).toBe(400);
  client.rpc.mockImplementation(async (name) => ({ data: name === "sensitive_data_organization" ? organization : name === "sensitive_pattern_source" ? [] : name === "stage_sensitive_write" ? id : 0 }));
  const scanned=await call({operation:"casework_scan_retaliation_patterns",args:{p_chapter_id:"synthetic-chapter"}});
  expect(scanned.code).toBe(200);
  expect(scanned.body).toEqual({data:0});
  expect(client.rpc).toHaveBeenCalledWith("write_sensitive_content",expect.objectContaining({p_operation:"casework_scan_retaliation_patterns",p_ticket:id}));
});

it.each([503, 502, 401, undefined, "timeout", "malformed"])("propagates Storage %s through the real handler to web and native transport as unavailable", async (status) => {
  rows = [{ id, object_name: "synthetic/path", member_cases: { organization_id: organization } }];
  client.storage = { from: () => ({ download: async () => {
    if (status === "timeout") throw new Error("synthetic upstream detail");
    if (status === "malformed") return {};
    return { error: { status, message: "synthetic upstream detail" } };
  } }) };
  const fetcher = async (_url, init) => {
    const reply = await call(JSON.parse(init.body), {}, filesHandler);
    expect(reply.code).toBe(503);
    expect(reply.body).toEqual({ error: "sensitive-document-unavailable" });
    return new Response(JSON.stringify(reply.body), { status: reply.code });
  };
  vi.stubGlobal("fetch", fetcher);
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic" } } }) } };
  await expect(downloadSensitiveCaseFile(transport, id)).rejects.toMatchObject({ staleVerdict: false });
  await expect(downloadSensitiveCaseBytes(transport, id, PORTAL_ORIGIN, fetcher)).rejects.toMatchObject({ staleVerdict: false });
});

it.each([false, true, null, "error"])("offers recheck only when caller RLS proves a non-current verdict (%s)", async (current) => {
  rows = [{ id, object_name: "synthetic/path" }];
  client.storage = { from: () => ({ download: async () => ({ error: { status: 403 }, failure: "denied" }) }) };
  client.rpc.mockResolvedValue(current === "error" ? { error: { message: "synthetic" } } : { data: current });
  const reply = await call({ action: "read", fileId: id }, {}, filesHandler);
  expect(reply.code).toBe(current === false ? 409 : 503);
  expect(client.rpc).toHaveBeenCalledWith("sensitive_case_read_current", { p_file_id: id });
});
it.each(["timeout", "malformed"])("returns a fixed unavailable response for a Storage %s", async (failure) => {
  rows = [{ id, object_name: "synthetic/path" }];
  client.storage = { from: () => ({ download: async () => { if (failure === "timeout") throw new Error("synthetic upstream detail"); return {}; } }) };
  const reply = await call({ action: "read", fileId: id }, {}, filesHandler);
  expect(reply.code).toBe(503);
  expect(reply.body).toEqual({ error: "sensitive-document-unavailable" });
});

it.each([
  [409, '<html>proxy conflict</html>', 'text/html', false],
  [409, '{"error":"file-recheck-required"', 'application/json', false],
  [409, '{"message":"file-recheck-required"}', 'application/json', false],
  [503, '{"error":"file-recheck-required"}', 'application/json', false],
  [409, '{"error":"file-recheck-required"}', 'application/json', true],
])("web/native transport requires a structured API verdict (%s, %s)", async (status, body, type, staleVerdict) => {
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-token" } } }) } };
  const fetcher = async () => new Response(body, { status, headers: { "content-type": type } });
  vi.stubGlobal("fetch", fetcher);
  await expect(downloadSensitiveCaseFile(transport, id)).rejects.toMatchObject({ staleVerdict });
  await expect(downloadSensitiveCaseBytes(transport, id, PORTAL_ORIGIN, fetcher)).rejects.toMatchObject({ staleVerdict });
});

it("reads a multi-megabyte case document from Storage in a single pass", async () => {
  const size = 3 * 1024 * 1024;
  const plaintext = Buffer.alloc(size, 97);
  const row = { id, organization_id: organization, size_bytes: size, object_name: "synthetic/full.txt", mime_type: "text/plain", member_cases: { organization_id: organization } };
  const sealed = encryptCaseDocument(plaintext, row, sensitiveKeyring());
  row.encrypted_content = sealed.envelope;
  const stored = sealed.ciphertext;
  let storageBytes = 0;
  const download = vi.fn(async () => { storageBytes += stored.length; return { data: new Blob([stored]), error: null }; });
  client.storage = { from: vi.fn(() => ({ download })) };
  rows = [row];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const reply = await call(JSON.parse(init.body), {}, filesHandler);
    return new Response(Buffer.isBuffer(reply.body) ? reply.body : JSON.stringify(reply.body), { status: reply.code, headers: reply.headers });
  }));
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-token" } } }) } };
  expect(Buffer.from(await downloadSensitiveCaseBytes(transport, id)).equals(plaintext)).toBe(true);
  expect(download).toHaveBeenCalledTimes(1);
  expect(storageBytes).toBeLessThanOrEqual(stored.length);
  expect(client.from.mock.calls.filter(([table]) => table === "member_case_files")).toHaveLength(1);
  const firstChunk = await call({ action: "read", fileId: id, offset: 0 }, {}, filesHandler);
  expect(firstChunk.body.length).toBe(1024 * 1024);
  expect((await call({ action: "read", fileId: id, offset: "full" }, {}, filesHandler)).body.equals(plaintext)).toBe(true);
});

it("keeps a full read of an oversized case document inside the platform response cap", async () => {
  const size = 6 * 1024 * 1024;
  const plaintext = Buffer.alloc(size, 99);
  const row = { id, organization_id: organization, size_bytes: size, object_name: "synthetic/oversized.txt", mime_type: "text/plain", member_cases: { organization_id: organization } };
  const sealed = encryptCaseDocument(plaintext, row, sensitiveKeyring());
  row.encrypted_content = sealed.envelope;
  client.storage = { from: vi.fn(() => ({ download: vi.fn(async () => ({ data: new Blob([sealed.ciphertext]), error: null })) })) };
  rows = [row];
  const bodies = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const reply = await call(JSON.parse(init.body), {}, filesHandler);
    if (Buffer.isBuffer(reply.body)) bodies.push(reply.body.length);
    return new Response(Buffer.isBuffer(reply.body) ? reply.body : JSON.stringify(reply.body), { status: reply.code, headers: reply.headers });
  }));
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-token" } } }) } };
  expect(Buffer.from(await downloadSensitiveCaseBytes(transport, id)).equals(plaintext)).toBe(true);
  expect(Math.max(...bodies)).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect((await call({ action: "read", fileId: id, offset: "full" }, {}, filesHandler)).body.length).toBe(1024 * 1024);
}, 30000);

it("rejects a truncated case-document body rather than returning partial plaintext", async () => {
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-token" } } }) } };
  const fetcher = vi.fn(async () => new Response(new Uint8Array(100), {
    headers: { "X-Sensitive-Data-Version": id, "X-Sensitive-Total-Bytes": String(3 * 1024 * 1024), "Content-Type": "text/plain" },
  }));
  await expect(downloadSensitiveCaseBytes(transport, id, "", fetcher)).rejects.toThrow("sensitive-document-incomplete");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("falls back to offset windows when a full read returns only the first chunk", async () => {
  const size = 3 * 1024 * 1024;
  const plaintext = Buffer.alloc(size, 98);
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-token" } } }) } };
  const fetcher = vi.fn(async (_url, init) => {
    const start = JSON.parse(init.body).offset ?? 0;
    return new Response(plaintext.subarray(start, start + 1024 * 1024), {
      headers: { "X-Sensitive-Data-Version": id, "X-Sensitive-Total-Bytes": String(size), "Content-Type": "text/plain" },
    });
  });
  expect(Buffer.from(await downloadSensitiveCaseBytes(transport, id, "", fetcher)).equals(plaintext)).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).offset).toBeUndefined();
  expect(fetcher.mock.calls.slice(1).map(([, init]) => JSON.parse(init.body).offset)).toEqual([1024 * 1024, 2 * 1024 * 1024]);
});

it("pages 405 authorized retaliation reports through the client without losing timestamp ties", async () => {
  const { loadMemberRetaliationReports } = await import("../src/lib/caseworkApi.js");
  const all = Array.from({ length: 405 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(405-index).padStart(12,"0")}`,
    organization_id: organization, created_at: "2026-09-01T00:00:00.123456+00:00", encrypted_content: {},
  }));
  let after, size;
  const chain = client.from();
  chain.or = vi.fn((filter) => { after = filter.match(/id.lt.([0-9a-f-]+)/)[1]; return chain; });
  chain.limit = vi.fn((limit) => { size = limit; return chain; });
  chain.then = (resolve) => Promise.resolve({ data: all.filter(row => !after || row.id < after).slice(0,size) }).then(resolve);
  const fetcher = vi.fn(async (_url, init) => {
    const res = await call(JSON.parse(init.body));
    return { ok: res.code === 200, json: async () => res.body };
  });
  vi.stubGlobal("fetch",fetcher);
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic" } } }) } };
  const found = await loadMemberRetaliationReports(transport,id);
  expect(found.map(row => row.id)).toEqual(all.map(row => row.id));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).args.cursor.createdAt).toBe(all[0].created_at);
  expect(chain.order).toHaveBeenCalledWith("id", { ascending: false });
  expect((await call({ operation: "list_retaliation", args: { caseId:id,cursor:{ id,createdAt:"bad,or(injected)" } } })).code).toBe(400);
});
