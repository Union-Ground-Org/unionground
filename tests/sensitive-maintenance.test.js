// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { maintainSensitiveFields } from "../scripts/sensitive-data-maintenance.mjs";
import { encryptSensitive, rotationReadKeyring, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { revealRow } from "../api/_lib/sensitiveContent.js";

it("backfills atomically, resumes with a cursor and rewraps without plaintext writes", async () => {
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  const row = { id: randomUUID(), organization_id: randomUUID(), description: "Synthetic sensitive detail", staff_note: "", encrypted_content: {} };
  let staged;
  const client = { query: vi.fn(async (sql, values = []) => {
    if (sql.startsWith("select *")) return { rows: sql.includes("member_accommodation") && values[0] < row.id ? [structuredClone(row)] : [] };
    if (sql.includes("app.sensitive_envelopes")) staged = JSON.parse(values[0]);
    if (sql.startsWith("update")) { row.encrypted_content = staged; row.description = values[0]; }
    return { rows: [] };
  }) };
  const first = await maintainSensitiveFields(client, { ring, limit: 1 });
  expect(first.processed).toBe(1);
  expect(first.exhausted).toBe(false);
  expect(row.description).toBe("[encrypted]");
  expect(revealRow("member_accommodation_requests", row, ring).description).toBe("Synthetic sensitive detail");
  expect((await maintainSensitiveFields(client, { ring, cursors: first.cursors })).processed).toBe(0);
  const restored = structuredClone(row.encrypted_content.description);
  const next = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v2: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v2" });
  await maintainSensitiveFields(client, { ring: next, oldRing: ring, mode: "rewrap" });
  expect(row.encrypted_content.description.payload).toEqual(restored.payload);
  expect(revealRow("member_accommodation_requests", row, next).description).toBe("Synthetic sensitive detail");
  expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("update")).every(([,values]) => values[0] === "[encrypted]")).toBe(true);
});
it("rolls back on missing keys and refuses invalid batch/mode options", async () => {
  const row = { id: randomUUID(), organization_id: randomUUID(), description: "Synthetic legacy text", encrypted_content: {} };
  const client = { query: vi.fn(async (sql) => ({ rows: sql.startsWith("select *") ? [row] : [] })) };
  await expect(maintainSensitiveFields(client, { ring: { keys: new Map() } })).rejects.toThrow("rolled-back");
  expect(client.query).toHaveBeenLastCalledWith("rollback");
  expect(client.query.mock.calls.some(([sql]) => sql.startsWith("update"))).toBe(false);
  await expect(maintainSensitiveFields(client, { mode: "delete", limit: 0 })).rejects.toThrow("invalid-options");
});

// An unconfirmed checkpoint may already have uploaded plaintext. Only a
// definitive Storage object-not-found result permits treating it as empty.
import { maintainSensitiveDocuments } from "../scripts/sensitive-document-maintenance.mjs";
import { openSensitiveWindow } from "../scripts/sensitive-data-rollout.mjs";
const outages = [
  ["503", { error: { status: 503, message: "synthetic upstream detail" } }],
  ["401", { error: { statusCode: "401" } }],
  ["403", { error: { statusCode: "403" } }],
  ["timeout", new Error("synthetic timeout")],
  ["malformed", { error: {} }],
  ["empty response", {}],
  ["ambiguous 404", { error: { status: 404 } }],
];
function documentProbe(retirement = false) {
  const row = { id: randomUUID(), object_name: "synthetic-legacy", confirmed_at: null, encrypted_content: null };
  let retired = false;
  const client = { query: vi.fn(async (sql, args = []) => {
    if (sql.includes("as closed")) return { rows: [{ closed: true, exposed: false }] };
    if (sql.includes("select f.*")) return { rows: !retirement && args[0] < row.id ? [row] : [] };
    if (sql.startsWith("delete from private.sensitive_retired_objects")) retired = true;
    if (sql.startsWith("select object_name")) return { rows: retired ? [] : [{ object_name: row.object_name }] };
    if (sql.includes("count(*)")) return { rows: [{ n: 0 }] };
    return { rows: [] };
  }) };
  return client;
}
it.each(outages)("keeps the window closed for an uploaded pending document on %s", async (_name, outcome) => {
  const client = documentProbe();
  const storage = { download: async () => { if (outcome instanceof Error) throw outcome; return outcome; } };
  await expect(openSensitiveWindow(client, storage, { ring: {} })).rejects.toThrow("sensitive-document-storage-unavailable");
  expect(client.query.mock.calls.some(([sql]) => sql.includes("do $restore$"))).toBe(false);
});
it.each(outages)("retains plaintext retirement evidence on %s", async (_name, outcome) => {
  const client = documentProbe(true);
  const storage = { remove: async () => ({ error: null }), download: async () => { if (outcome instanceof Error) throw outcome; return outcome; } };
  await expect(maintainSensitiveDocuments(client, storage, { ring: {} })).rejects.toThrow("sensitive-document-storage-unavailable");
  expect(client.query.mock.calls.some(([sql]) => sql.startsWith("delete from private.sensitive_retired_objects"))).toBe(false);
});
it("refuses SDK-normalized object-not-found errors without raw provenance", async () => {
  const client = documentProbe();
  const storage = { download: async () => ({ data: null, error: { status: 400, statusCode: "404", message: "Object not found" } }) };
  await expect(openSensitiveWindow(client, storage, { ring: {} })).rejects.toThrow("sensitive-document-storage-unavailable");
  expect(client.query.mock.calls.some(([sql]) => sql.includes("do $restore$"))).toBe(false);
});

function rotationRings() {
  return ["v1","v2"].map(active => sensitiveKeyring("saas", {
    SENSITIVE_DATA_KEYS: JSON.stringify({ [active]: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: active,
  }));
}
it("resumes a partially committed field rotation and authenticates but skips completed rows", async () => {
  const [oldRing,ring] = rotationRings();
  const rows = [1,2].map(n => {
    const row = { id: `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`, organization_id: randomUUID(), description:"[encrypted]", staff_note:"" };
    row.encrypted_content = { description: encryptSensitive(Buffer.from("Synthetic field"), { organization:row.organization_id,record:row.id,field:"description",purpose:"member_accommodation_requests" },oldRing) };
    return row;
  });
  let interrupted = true, staged;
  const client = { query:vi.fn(async (sql,args=[]) => {
    if (sql.startsWith("select *")) {
      const row = sql.includes("member_accommodation") && rows.find(row => row.id > args[0]);
      if (row === rows[1] && interrupted) throw new Error("synthetic interruption");
      return { rows:row ? [structuredClone(row)] : [] };
    }
    if (sql.includes("app.sensitive_envelopes")) staged = JSON.parse(args[0]);
    if (sql.startsWith("update")) rows.find(row => row.id === args.at(-1)).encrypted_content = staged;
    return { rows:[] };
  }) };
  await expect(maintainSensitiveFields(client,{ ring,oldRing,mode:"rewrap" })).rejects.toThrow("rolled-back");
  expect(rows.map(row => row.encrypted_content.description.keyVersion)).toEqual(["v2","v1"]);
  const completed = structuredClone(rows[0]);
  interrupted = false; client.query.mockClear();
  await maintainSensitiveFields(client,{ ring,oldRing,mode:"rewrap" });
  expect(rows[0]).toEqual(completed);
  expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("update"))).toHaveLength(1);
  expect(rows.map(row => revealRow("member_accommodation_requests",row,ring).description)).toEqual(["Synthetic field","Synthetic field"]);
  rows[0].encrypted_content.description.payload.tag = randomBytes(16).toString("base64");
  await expect(maintainSensitiveFields(client,{ ring,oldRing,mode:"rewrap" })).rejects.toThrow("rolled-back");
});
it("resumes a partially committed document rotation after a Storage outage", async () => {
  const { encryptCaseDocument, decryptCaseDocument } = await import("../api/_lib/sensitiveCaseDocuments.js");
  const [oldRing,ring] = rotationRings();
  const objects = new Map();
  const rows = [1,2].map(n => {
    const row = { id:`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,organization_id:randomUUID(),object_name:`synthetic-${n}`,size_bytes:4,confirmed_at:"synthetic" };
    const encrypted = encryptCaseDocument(Buffer.from("test"),row,oldRing);
    row.encrypted_content = encrypted.envelope; objects.set(row.object_name,encrypted.ciphertext);
    return row;
  });
  let interrupted = true;
  const client = { query:vi.fn(async (sql,args=[]) => {
    if (sql.includes("select f.*")) return { rows:rows.filter(row => row.id > args[0]).slice(0,1).map(row => structuredClone(row)) };
    if (sql.startsWith("update")) rows.find(row => row.id === args[1]).encrypted_content = args[0];
    return { rows:[] };
  }) };
  const storage = { download:async name => interrupted && name === rows[1].object_name ? { error:{ status:503 } } : { data:new Blob([objects.get(name)]) } };
  await expect(maintainSensitiveDocuments(client,storage,{ ring,oldRing,mode:"rewrap" })).rejects.toThrow("storage-unavailable");
  expect(rows.map(row => row.encrypted_content.keyVersion)).toEqual(["v2","v1"]);
  const completed = structuredClone(rows[0]);
  interrupted = false; client.query.mockClear();
  await maintainSensitiveDocuments(client,storage,{ ring,oldRing,mode:"rewrap" });
  expect(rows[0]).toEqual(completed);
  expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("update"))).toHaveLength(1);
  for (const row of rows) expect(decryptCaseDocument(objects.get(row.object_name),row,ring).toString()).toBe("test");
});
it("rejects conflicting rotation versions and preserves both revocation sets", () => {
  const [oldRing,ring] = rotationRings();
  oldRing.revoked.add(randomUUID()); ring.revoked.add(randomUUID());
  expect(rotationReadKeyring(oldRing,ring).revoked.size).toBe(2);
  ring.keys.set("v1",randomBytes(32));
  expect(() => rotationReadKeyring(oldRing,ring)).toThrow("unavailable");
});
