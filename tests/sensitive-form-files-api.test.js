// @vitest-environment node
// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022 (#5747): sealed
// FMLA form attachments are stored as ciphertext by the server, in the
// case-file protection class but with their own purpose strings.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import filesHandler from "../api/sensitive-form-files.js";
import { encryptCaseDocument } from "../api/_lib/sensitiveCaseDocuments.js";
import { decryptFormDocument, decryptInspectedFormDocument, encryptFormDocument, sealedFormInspectionRow } from "../api/_lib/sensitiveFormDocuments.js";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { createSensitiveStorage } from "../api/_lib/sensitiveStorage.js";
import { downloadSensitiveFormFile, uploadSensitiveFormFile } from "../src/lib/sensitiveContentApi.js";
import { PORTAL_HOST, PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("../api/_lib/sensitiveStorage.js", async (original) => {
  const actual = await original();
  return { ...actual, createSensitiveStorage: vi.fn((...args) => createClient(...args).storage.from(args[2]?.bucket)) };
});
const organization = randomUUID(), id = randomUUID();
let client, chain;
function response() {
  return { status(code) { this.code = code; return this; }, setHeader(name, value) { this.headers ??= {}; this.headers[name] = value; return this; },
    end(body) { this.body = Buffer.isBuffer(body) ? Buffer.from(body) : JSON.parse(body); } };
}
async function call(body, headers = {}, method = "POST") {
  const res = response();
  await filesHandler({ method, headers: { host: PORTAL_HOST, authorization: "Bearer caller-token", ...headers }, body }, res);
  return res;
}
beforeEach(() => {
  vi.stubEnv("SENSITIVE_DATA_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
  vi.stubEnv("SENSITIVE_DATA_ACTIVE_KEY", "v1");
  chain = {};
  for (const name of ["select", "eq", "gt", "lt", "order", "delete", "in"]) chain[name] = vi.fn(() => chain);
  chain.then = (resolve) => Promise.resolve({ data: [], error: null }).then(resolve);
  chain.single = vi.fn(async () => ({ data: null, error: { code: "42501" } }));
  client = { auth: { getUser: vi.fn(async () => ({ data: { user: { id } } })) }, rpc: vi.fn(async () => ({ data: null, error: { code: "42501" } })), from: vi.fn(() => chain) };
  vi.mocked(createClient).mockReturnValue(client);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("uploads only ciphertext to member-form-files, records the envelope once, and decrypts a caller-authorized read", async () => {
  const plaintext = Buffer.from("Synthetic medical certification");
  const row = { id, organization_id: organization, size_bytes: plaintext.length, object_name: "authorized/form.txt", mime_type: "text/plain" };
  let stored;
  client.rpc.mockImplementation(async (operation, args) => {
    if (operation === "sensitive_form_upload_target") return { data: row };
    if (operation === "set_sensitive_form_envelope") { row.encrypted_content = args.p_envelope; return { data: true }; }
    return { data: null };
  });
  const upload = vi.fn(async (_path, bytes) => { stored = Buffer.from(bytes); return { error: null }; });
  const download = vi.fn(async () => ({ data: new Blob([stored]), error: null }));
  client.storage = { from: vi.fn(() => ({ upload, download })) };
  expect((await call({ action: "upload", fileId: id, bytes: plaintext.toString("base64") })).code).toBe(200);
  expect(client.storage.from).toHaveBeenCalledWith("member-form-files");
  expect(stored.equals(plaintext)).toBe(false);
  expect(stored.length).toBe(plaintext.length);
  expect(row.encrypted_content).toMatchObject({ purpose: "form-document", field: "bytes", record: id, organization });
  expect(row.encrypted_content.payload).not.toHaveProperty("ciphertext");
  chain.single.mockResolvedValue({ data: { ...row, member_forms: { organization_id: organization } }, error: null });
  const read = await call({ action: "read", fileId: id });
  expect(read.code).toBe(200);
  expect(read.body).toEqual(plaintext);
  expect(read.headers["Cache-Control"]).toBe("no-store");
  expect(createSensitiveStorage).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ token: "caller-token", bucket: "member-form-files" }));
  stored[0] ^= 1;
  expect((await call({ action: "read", fileId: id })).code).toBe(503);
});

it("refuses an unauthorized target, an unsealed or missing read row, oversized chunks and bad ids", async () => {
  expect((await call({ action: "upload", fileId: id, bytes: "dGVzdA==" })).code).toBe(403);
  expect((await call({ action: "read", fileId: id })).code).toBe(403);
  chain.single.mockResolvedValue({ data: { id, size_bytes: 4, encrypted_content: null, member_forms: { organization_id: organization } }, error: null });
  expect((await call({ action: "read", fileId: id })).code).toBe(403);
  expect((await call({ action: "read", fileId: "invalid" })).code).toBe(400);
  expect((await call({ action: "upload", fileId: id, bytes: "x".repeat(4 * 1024 * 1024 + 1) })).code).toBe(413);
  expect((await call({}, { origin: "https://foreign.invalid" })).code).toBe(403);
});

it("requires POST, a bearer and a supported action before querying a file", async () => {
  expect((await call(undefined, {}, "GET")).code).toBe(405);
  expect((await call({ action: "read", fileId: id }, { authorization: "", origin: PORTAL_ORIGIN })).code).toBe(401);
  expect((await call({ action: "erase", fileId: id })).code).toBe(400);
  expect((await call()).code).toBe(400);
  expect(client.rpc).not.toHaveBeenCalled();
  expect(client.from).not.toHaveBeenCalled();
});

it.each([0, 10 * 1024 * 1024 + 1])("refuses an upload target of %s bytes before storage I/O", async (size_bytes) => {
  client.rpc.mockResolvedValue({ data: { id, organization_id: organization, size_bytes } });
  expect((await call({ action: "upload", fileId: id, bytes: "YWJj" })).code).toBe(413);
  expect(client.from).not.toHaveBeenCalled();
});

it.each([-1, 0.5, 1])("refuses an invalid chunk index %s without persisting a fragment", async (index) => {
  client.rpc.mockResolvedValue({ data: { id, organization_id: organization, size_bytes: 3 } });
  expect((await call({ action: "chunk", fileId: id, bytes: "YWJj", index })).code).toBe(400);
  expect(client.from).not.toHaveBeenCalled();
});

it.each(["YWJj!", "YQ=="])("refuses malformed or wrong-sized chunk bytes (%s)", async (bytes) => {
  client.rpc.mockResolvedValue({ data: { id, organization_id: organization, size_bytes: 3 } });
  expect((await call({ action: "chunk", fileId: id, bytes, index: 0 })).code).toBe(400);
  expect(client.from).not.toHaveBeenCalled();
});

it("reports a chunk persistence failure and never marks an upload finished", async () => {
  client.rpc.mockResolvedValue({ data: { id, organization_id: organization, size_bytes: 3 } });
  chain.upsert = vi.fn(async () => ({ error: { code: "42501" } }));
  const result = await call({ action: "chunk", fileId: id, bytes: "YWJj", index: 0 });
  expect(result.code).toBe(503);
  expect(result.body).toEqual({ error: "sensitive-data-key-or-backfill-unavailable" });
  expect(chain.upsert).toHaveBeenCalledWith(expect.objectContaining({ file_id: id, chunk_index: 0,
    envelope: expect.objectContaining({ purpose: "form-document-chunk-a" }) }));
  expect(client.rpc).not.toHaveBeenCalledWith("set_sensitive_form_envelope", expect.anything());
});

it("rejects noncanonical upload bytes before creating an envelope", async () => {
  client.rpc.mockResolvedValue({ data: { id, organization_id: organization, size_bytes: 3 } });
  expect((await call({ action: "upload", fileId: id, bytes: "YWJj!" })).code).toBe(400);
  expect(client.rpc).toHaveBeenCalledTimes(1);
});

it.each([[{ error: { code: "42501" } }, 503], [{ data: false }, 409]])(
  "refuses storage writes when the envelope cannot be recorded (%#)", async (saved, code) => {
    const upload = vi.fn();
    client.storage = { from: vi.fn(() => ({ upload })) };
    client.rpc.mockImplementation(async (operation) => operation === "sensitive_form_upload_target"
      ? { data: { id, organization_id: organization, size_bytes: 3, object_name: "synthetic/form.txt", mime_type: "text/plain" } } : saved);
    expect((await call({ action: "upload", fileId: id, bytes: "YWJj" })).code).toBe(code);
    expect(upload).not.toHaveBeenCalled();
  },
);

it("reports a ciphertext upload failure instead of claiming the file was uploaded", async () => {
  client.rpc.mockImplementation(async (operation) => operation === "sensitive_form_upload_target"
    ? { data: { id, organization_id: organization, size_bytes: 3, object_name: "synthetic/form.txt", mime_type: "text/plain" } } : { data: true });
  client.storage = { from: () => ({ upload: vi.fn(async () => ({ error: { status: 500 } })) }) };
  expect((await call({ action: "upload", fileId: id, bytes: "YWJj" })).code).toBe(503);
});

it.each([-1, 0.5, 1, 10 * 1024 * 1024])("rejects invalid read offset %s before querying a file", async (offset) => {
  expect((await call({ action: "read", fileId: id, offset })).code).toBe(400);
  expect(client.from).not.toHaveBeenCalled();
});

it.each([
  ["absent", false, 409], ["denied", false, 409], ["absent", true, 503], ["unavailable", false, 503],
])("requires a current SQL refusal before suggesting recheck (%s, %s)", async (failure, current, code) => {
  chain.single.mockResolvedValue({ data: { id, object_name: "synthetic/form.txt", encrypted_content: {} } });
  client.storage = { from: () => ({ download: vi.fn(async () => ({ error: "storage-unavailable", failure })) }) };
  client.rpc.mockResolvedValue({ data: current });
  expect((await call({ action: "read", fileId: id })).code).toBe(code);
  expect(client.rpc).toHaveBeenCalledTimes(failure === "unavailable" ? 0 : 1);
});

it.each([
  ["rejected download", () => { throw new Error("network"); }],
  ["missing data", async () => ({ data: null })],
  ["non-blob data", async () => ({ data: {} })],
  ["broken byte stream", async () => ({ data: { arrayBuffer: async () => { throw new Error("truncated"); } } })],
])("keeps %s unavailable without returning document bytes", async (_name, download) => {
  chain.single.mockResolvedValue({ data: { id, object_name: "synthetic/form.txt", encrypted_content: {} } });
  client.storage = { from: () => ({ download }) };
  const result = await call({ action: "read", fileId: id });
  expect(result.code).toBe(503);
  expect(result.body).toEqual({ error: "sensitive-document-unavailable" });
});

it("keeps a form document and a case document from opening as each other", () => {
  const ring = sensitiveKeyring();
  const row = { id, organization_id: organization, size_bytes: 5 };
  const form = encryptFormDocument(Buffer.from("bytes"), row, ring);
  expect(decryptFormDocument(form.ciphertext, { ...row, encrypted_content: form.envelope }, ring).toString()).toBe("bytes");
  const asCase = encryptCaseDocument(Buffer.from("bytes"), row, ring);
  expect(() => decryptFormDocument(asCase.ciphertext, { ...row, encrypted_content: asCase.envelope }, ring)).toThrow();
});

it("tells the inspector a form attachment is sealed only from the attempt-bound service projection", async () => {
  const backend = { url: "https://test.invalid", serviceRoleKey: "synthetic", surface: "saas" };
  const target = { fileId: id, attemptId: randomUUID(), objectName: "synthetic/form.pdf" };
  client.rpc.mockResolvedValue({ data: null, error: null });
  expect(await sealedFormInspectionRow(backend, target)).toBeNull();
  expect(client.rpc).toHaveBeenCalledWith("sensitive_form_inspection_metadata", { p_file_id: id, p_attempt_id: target.attemptId });
  client.rpc.mockResolvedValue({ data: { id, object_name: "another/path" }, error: null });
  await expect(sealedFormInspectionRow(backend, target)).rejects.toThrow("sensitive-document-unavailable");
  client.rpc.mockResolvedValue({ data: null, error: { message: "x" } });
  await expect(sealedFormInspectionRow(backend, target)).rejects.toThrow("sensitive-document-unavailable");
  const row = { id, organization_id: organization, size_bytes: 3, object_name: target.objectName };
  const sealed = encryptFormDocument(Buffer.from("pdf"), row, sensitiveKeyring());
  client.rpc.mockResolvedValue({ data: { ...row, encrypted_content: sealed.envelope }, error: null });
  const found = await sealedFormInspectionRow(backend, target);
  expect(decryptInspectedFormDocument(backend, found, sealed.ciphertext).toString()).toBe("pdf");
});

it("transports a 10 MiB attachment as bounded encrypted chunks and reads it back in windows", async () => {
  const size = 10 * 1024 * 1024;
  const plaintext = Buffer.alloc(size, 98);
  const row = { id, organization_id: organization, size_bytes: size, object_name: "synthetic/chunked.pdf", mime_type: "application/pdf" };
  const chunks = new Map(); let stored;
  const storage = { upload: vi.fn(async (_path, bytes) => { stored = Buffer.from(bytes); return { error: null }; }), download: vi.fn(async () => ({ data: new Blob([stored]) })) };
  client.storage = { from: () => storage };
  client.from.mockImplementation((table) => {
    if (table === "sensitive_form_chunks") {
      const chunkChain = {};
      for (const name of ["select", "eq", "gt", "lt", "order", "delete"]) chunkChain[name] = () => chunkChain;
      chunkChain.upsert = vi.fn(async (part) => { chunks.set(part.chunk_index, part); return { error: null }; });
      chunkChain.then = (resolve) => Promise.resolve({ data: [...chunks.values()].sort((a, b) => a.chunk_index - b.chunk_index) }).then(resolve);
      return chunkChain;
    }
    return chain;
  });
  client.rpc.mockImplementation(async (operation, args) => {
    if (operation === "sensitive_form_upload_target") return { data: row };
    if (operation === "set_sensitive_form_envelope") { row.encrypted_content = args.p_envelope; return { data: true }; }
    return { data: null };
  });
  chain.single.mockImplementation(async () => ({ data: { ...row, member_forms: { organization_id: organization } }, error: null }));
  const requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    expect(url).toBe("/api/sensitive-form-files");
    expect(init.body.length).toBeLessThan(1500000);
    const body = JSON.parse(init.body); requests.push(body.action);
    const reply = await call(body);
    return new Response(Buffer.isBuffer(reply.body) ? reply.body : JSON.stringify(reply.body), { status: reply.code, headers: reply.headers });
  }));
  const transport = { auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-token" } } }) } };
  expect(await uploadSensitiveFormFile(transport, id, new Blob([plaintext]))).toEqual({ error: null });
  expect(requests.filter((action) => action === "chunk")).toHaveLength(10);
  expect(requests.at(-1)).toBe("finish");
  expect(stored.equals(plaintext)).toBe(false);
  const blob = await downloadSensitiveFormFile(transport, id);
  expect(Buffer.from(await blob.arrayBuffer()).equals(plaintext)).toBe(true);
});

// BUG-UG-FORM-FILE-WITH-UNFINISHED-SAFETY-CHECK-CANNOT-BE-REMOVED-20261112 (#8569).
describe("remove", () => {
  const objectName = `form-1/${id}/proof.pdf`;
  let service;
  function serve({ requested = { data: { id, bucketId: "member-form-files", objectName }, error: null },
    removed = { data: [{ name: objectName }], error: null }, finalized = { data: { deleted: true, id }, error: null } } = {}) {
    client.rpc.mockImplementation(async (name) => {
      if (name === "request_member_form_file_removal") return requested;
      if (name === "finalize_member_form_file_removal") return finalized;
      return { data: null, error: { code: "42501" } };
    });
    const remove = vi.fn(async () => removed);
    service = { storage: { from: vi.fn(() => ({ remove })) }, rpc: vi.fn(), from: vi.fn() };
    // The member's client carries their bearer; the service client does not.
    vi.mocked(createClient).mockImplementation((_url, _key, options) => (options?.global?.headers?.Authorization ? client : service));
    return remove;
  }

  it("marks with the member's token, deletes only the object that call names, then finalizes as the member", async () => {
    const remove = serve();
    const result = await call({ action: "remove", fileId: id, bucketId: "case-files", objectName: "someone-else/file.pdf" });
    expect(result.code).toBe(200);
    expect(result.body).toEqual({ fileId: id, status: "removed", receipt: { deleted: true, id } });
    expect(client.rpc).toHaveBeenNthCalledWith(1, "request_member_form_file_removal", { p_file_id: id });
    expect(service.storage.from).toHaveBeenCalledWith("member-form-files");
    expect(remove).toHaveBeenCalledWith([objectName]);
    expect(client.rpc).toHaveBeenNthCalledWith(2, "finalize_member_form_file_removal", { p_file_id: id });
    expect(client.rpc.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(client.rpc.mock.invocationCallOrder[1]);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["refused by the request", { data: null, error: { code: "22023", message: "file unavailable" } }],
    ["outside the form bucket", { data: { id, bucketId: "case-files", objectName }, error: null }],
    ["without an object", { data: { id, bucketId: "member-form-files" }, error: null }],
  ])("deletes nothing when the removal request is %s", async (_label, requested) => {
    const remove = serve({ requested });
    const result = await call({ action: "remove", fileId: id });
    expect(result.code).toBe(403);
    expect(result.body).toEqual({ error: "not-authorized" });
    expect(remove).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith("finalize_member_form_file_removal", expect.anything());
  });

  it("leaves the mark for a retry and never reports success when Storage refuses", async () => {
    serve({ removed: { data: null, error: { message: "The service is currently unavailable" } } });
    const result = await call({ action: "remove", fileId: id });
    expect(result.code).toBe(503);
    expect(result.body).toEqual({ error: "form-file-removal-unavailable" });
    expect(client.rpc).not.toHaveBeenCalledWith("finalize_member_form_file_removal", expect.anything());
  });

  it("never reports success when finalize still finds the bytes", async () => {
    serve({ removed: { data: [], error: null }, finalized: { data: null, error: { code: "22023", message: "attachment bytes still exist" } } });
    const result = await call({ action: "remove", fileId: id });
    expect(result.code).toBe(503);
    expect(result.body).toEqual({ error: "form-file-removal-unavailable" });
  });

  it("refuses a foreign origin or missing bearer before calling the removal RPC", async () => {
    const remove = serve();
    expect((await call({ action: "remove", fileId: id }, { origin: "https://foreign.invalid" })).code).toBe(403);
    const unauthenticated = await call({ action: "remove", fileId: id }, { authorization: "", origin: PORTAL_ORIGIN });
    expect(unauthenticated.code).toBe(401);
    expect(unauthenticated.body).toEqual({ error: "not-authorized" });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
