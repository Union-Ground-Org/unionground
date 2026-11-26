// @vitest-environment node
// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022 (#5747): the
// maintenance-window backfill seals legacy FMLA answers, freezes the digest of
// submitted rows, rewraps on rotation and verifies nothing is left in plaintext.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maintainSealedForms, assertSealedFormStorageTarget } from "../scripts/sensitive-form-maintenance.mjs";
import { revealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { encryptSensitive, rewrapSensitive, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { formChunkContext } from "../api/_lib/sensitiveFormDocuments.js";
import { openSensitiveWindow, runSensitiveMaintenance } from "../scripts/sensitive-data-rollout.mjs";

const organization = randomUUID();
const ringFor = (version) => sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ [version]: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: version });

function fakeDatabase(rows, { digest = "frozen-digest", chapterOrganization = organization } = {}) {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const log = [];
  let settings = {};
  const client = {
    log,
    async query(sql, values = []) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql === "begin" || sql === "commit" || sql === "rollback") { settings = {}; return { rows: [] }; }
      if (sql.startsWith("select set_config('app.sensitive_maintenance'")) { settings.maintenance = true; return { rows: [] }; }
      if (sql.startsWith("select set_config('app.sensitive_envelopes'")) { settings.envelopes = JSON.parse(values[0]); return { rows: [] }; }
      if (sql.includes("from public.member_forms where template_key")) return { rows: sorted.filter((row) => row.id > values[0]).slice(0, 1) };
      if (sql.includes("from public.member_profiles")) return { rows: chapterOrganization ? [{ organization_id: chapterOrganization }] : [] };
      if (sql.includes("private.form_content_digest")) return { rows: [{ digest }] };
      if (sql.startsWith("update public.member_forms set organization_id = $1 where id = $2")) {
        const row = sorted.find((item) => item.id === values[1]);
        expect(settings.maintenance).toBe(true);
        row.organization_id = values[0];
        return { rows: [] };
      }
      if (sql.startsWith("update public.member_forms set organization_id")) {
        const row = sorted.find((item) => item.id === values[2]);
        expect(settings.maintenance).toBe(true);
        Object.assign(row, { organization_id: values[0], answers: values[1], encrypted_content: { answers: settings.envelopes.answers } });
        return { rows: [] };
      }
      if (sql.startsWith("update public.member_forms set updated_at")) {
        const row = sorted.find((item) => item.id === values[0]);
        row.encrypted_content = { answers: settings.envelopes.answers };
        return { rows: [] };
      }
      throw new Error(`unexpected ${sql}`);
    },
  };
  return client;
}
const form = (overrides) => ({ id: randomUUID(), user_id: randomUUID(), template_key: "fmla_self", status: "draft", answers: {}, organization_id: null, encrypted_content: {}, ...overrides });

describe("sealed FMLA form maintenance", () => {
  it("seals plaintext rows, freezes the digest of submitted ones and leaves empty rows alone", async () => {
    const ring = ringFor("v1");
    const draft = form({ answers: { reason: "legacy reason", notes: "" } });
    const approved = form({ status: "approved", answers: { reason: "approved reason" } });
    const empty = form({ answers: { seedSequence: 4 } });
    const client = fakeDatabase([draft, approved, empty]);
    const result = await maintainSealedForms(client, { ring });
    expect(result).toMatchObject({ processed: 3, exhausted: true });
    expect(draft.answers).toEqual({ sealed: true, filled: ["reason"], dataVersion: draft.encrypted_content.answers.dataVersion });
    expect(approved.answers).toMatchObject({ sealed: true, legacyDigest: "frozen-digest" });
    expect(draft.organization_id).toBe(organization);
    expect(revealFormAnswers(draft, ring)).toEqual({ reason: "legacy reason", notes: "" });
    expect(revealFormAnswers(approved, ring)).toEqual({ reason: "approved reason" });
    expect(empty.answers).toEqual({ seedSequence: 4 });
    // #5827 r1s3: an empty legacy draft still gets its organization.
    expect(empty.organization_id).toBe(organization);
    expect(JSON.stringify([draft, approved])).not.toContain("legacy reason");
  });

  // #6320: a legacy form answering all 120 fields of four 30-field steps
  // backfills without losing an answer.
  it("backfills a plaintext form with 120 answers without loss", async () => {
    const ring = ringFor("v1");
    const answers = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field_${index}`, `answer ${index}`]));
    const legacy = form({ answers });
    await maintainSealedForms(fakeDatabase([legacy]), { ring });
    expect(legacy.answers).toMatchObject({ sealed: true });
    expect(legacy.answers.filled).toHaveLength(120);
    expect(revealFormAnswers(legacy, ring)).toEqual(answers);
  });

  // #6363 round 1: a legacy answer named "sealed" is not a marker; without an
  // envelope the row is plaintext and the backfill seals it.
  it("backfills a legacy form whose answers include a checkbox named sealed", async () => {
    const ring = ringFor("v1");
    const legacy = form({ answers: { sealed: true, reason: "legacy reason" } });
    await maintainSealedForms(fakeDatabase([legacy]), { ring });
    expect(legacy.answers).toMatchObject({ sealed: true, filled: ["sealed", "reason"] });
    expect(revealFormAnswers(legacy, ring)).toEqual({ sealed: true, reason: "legacy reason" });
  });

  it("verify accepts sealed rows and refuses any plaintext one", async () => {
    const ring = ringFor("v1");
    const sealed = form({ answers: { reason: "x" } });
    await maintainSealedForms(fakeDatabase([sealed]), { ring });
    expect(await maintainSealedForms(fakeDatabase([sealed]), { ring, mode: "verify" })).toMatchObject({ processed: 1 });
    await expect(maintainSealedForms(fakeDatabase([form({ answers: { reason: "plaintext" } })]), { ring, mode: "verify" }))
      .rejects.toThrow("sensitive-data-backfill-required");
  });

  it("verify refuses an empty FMLA row that never got its organization", async () => {
    await expect(maintainSealedForms(fakeDatabase([form({ answers: {} })]), { ring: ringFor("v1"), mode: "verify" }))
      .rejects.toThrow("sensitive-data-backfill-required");
  });

  it("rewraps a sealed row under the new key without changing its content version", async () => {
    const oldRing = ringFor("v1");
    const row = form({ answers: { reason: "rotate me" } });
    await maintainSealedForms(fakeDatabase([row]), { ring: oldRing });
    const before = row.encrypted_content.answers;
    const ring = { ...ringFor("v2") };
    await maintainSealedForms(fakeDatabase([row]), { ring, oldRing, mode: "rewrap" });
    expect(row.encrypted_content.answers.keyVersion).toBe("v2");
    expect(row.encrypted_content.answers.dataVersion).toBe(before.dataVersion);
    expect(revealFormAnswers(row, ring)).toEqual({ reason: "rotate me" });
  });

  it("does not skip or overwrite an envelope whose sealed marker is missing", async () => {
    const ring = ringFor("v1");
    const row = form({ answers: { reason: "Retained envelope" } });
    const database = fakeDatabase([row]);
    await maintainSealedForms(database, { ring });
    row.answers = {};
    for (const mode of ["backfill", "rewrap", "verify"]) {
      await expect(maintainSealedForms(database, { ring, mode })).rejects.toThrow("sensitive-form-envelope-marker-required");
    }
  });

  it("rolls back and refuses a row whose organization cannot be resolved or whose digest is missing", async () => {
    const ring = ringFor("v1");
    await expect(maintainSealedForms(fakeDatabase([form({ answers: { reason: "x" } })], { chapterOrganization: null }), { ring }))
      .rejects.toThrow("sensitive-form-organization-unresolved");
    const client = fakeDatabase([form({ status: "submitted", answers: { reason: "x" } })], { digest: null });
    await expect(maintainSealedForms(client, { ring })).rejects.toThrow("sensitive-form-digest-unavailable");
    expect(client.log.at(-1)).toBe("rollback");
  });

  it("refuses unknown modes and unbounded batches", async () => {
    await expect(maintainSealedForms(fakeDatabase([]), { ring: ringFor("v1"), mode: "drop" })).rejects.toThrow("sensitive-maintenance-invalid-options");
    await expect(maintainSealedForms(fakeDatabase([]), { ring: ringFor("v1"), limit: 5000 })).rejects.toThrow("sensitive-maintenance-invalid-options");
  });
});

describe("sealed FMLA attachment maintenance", () => {
  function fileWorld(rows, chunks = []) {
    const objects = new Map(rows.map((row) => [row.object_name, Buffer.from(row.plaintext)]));
    const retired = new Set();
    let maintenance = false;
    const storage = {
      async download(name) {
        const bytes = objects.get(name);
        return bytes ? { data: new Blob([bytes]), error: null } : { data: null, error: "x", failure: "absent" };
      },
      async upload(name, bytes) { objects.set(name, Buffer.from(bytes)); return { error: null }; },
      async remove(names) { for (const name of names) objects.delete(name); return { error: null }; },
    };
    const client = {
      async query(sql, values = []) {
        if (["begin", "commit", "rollback"].includes(sql)) { maintenance = false; return { rows: [] }; }
        if (sql.startsWith("select set_config('app.sensitive_maintenance'")) { maintenance = true; return { rows: [] }; }
        if (sql.startsWith("select set_config('app.sensitive_envelopes'")) return { rows: [] };
        if (sql.includes("from public.member_form_files ff")) return { rows: rows.filter((row) => row.id > values[0]).slice(0, 1) };
        if (sql.startsWith("delete from public.sensitive_form_chunks")) {
          for (let index = chunks.length - 1; index >= 0; index -= 1) {
            if (Date.parse(chunks[index].expires_at) < Date.now()) chunks.splice(index, 1);
          }
          return { rows: [] };
        }
        if (sql.includes("from public.sensitive_form_chunks")) return { rows: chunks.filter(row =>
          row.file_id > values[0] || (row.file_id === values[0] && row.chunk_index > values[1])).slice(0, 1) };
        if (sql.startsWith("update public.sensitive_form_chunks set envelope")) {
          chunks.find(row => row.file_id === values[1] && row.chunk_index === values[2]).envelope = values[0];
          return { rows: [] };
        }
        if (sql.startsWith("insert into private.sensitive_retired_form_objects")) { retired.add(values[0]); return { rows: [] }; }
        if (sql.startsWith("update public.member_form_files set object_name")) {
          expect(maintenance).toBe(true);
          Object.assign(rows.find((row) => row.id === values[2]), { object_name: values[0], encrypted_content: values[1] });
          return { rows: [] };
        }
        if (sql.startsWith("update public.member_form_files set encrypted_content")) {
          expect(maintenance).toBe(true);
          rows.find(row => row.id === values[1]).encrypted_content = values[0];
          return { rows: [] };
        }
        if (sql.startsWith("select object_name from private.sensitive_retired_form_objects")) return { rows: [...retired].map((name) => ({ object_name: name })) };
        if (sql.includes("count(*)") && sql.includes("private.sensitive_retired_form_objects")) return { rows: [{ n: retired.size }] };
        if (sql.startsWith("delete from private.sensitive_retired_form_objects")) { retired.delete(values[0]); return { rows: [] }; }
        throw new Error(`unexpected ${sql}`);
      },
    };
    return { client, storage, objects, retired };
  }
  const file = (plaintext) => ({ id: randomUUID(), form_id: randomUUID(), organization_id: organization, object_name: `forms/${randomUUID()}.txt`,
    mime_type: "text/plain", size_bytes: Buffer.byteLength(plaintext), confirmed_at: "2026-10-01T00:00:00Z", encrypted_content: null, plaintext });

  async function hostedWorld({ plaintext = false, ignore = null } = {}) {
    const oldRing = ringFor("v1");
    const next = ringFor("v2");
    const ring = { ...next, keys: new Map([...oldRing.keys, ...next.keys]) };
    const row = form({ answers: { reason: "Rotation proof" } });
    const document = file("Rotation attachment");
    const chunk = { file_id: document.id, chunk_index: 0, expires_at: "2099-01-01T00:00:00Z" };
    chunk.envelope = encryptSensitive(Buffer.from("Staged attachment"), formChunkContext(document, 0), oldRing);
    const forms = fakeDatabase([row]);
    const files = fileWorld([document], [chunk]);
    const { maintainSealedFormFiles } = await import("../scripts/sensitive-form-maintenance.mjs");
    if (!plaintext) {
      await maintainSealedForms(forms, { ring: oldRing });
      await maintainSealedFormFiles(files.client, files.storage, { ring: oldRing });
    }
    const client = { async query(sql, values = []) {
      if (sql.includes("as closed")) return { rows: [{ closed: true, exposed: false }] };
      if (sql.includes("to_regclass")) return { rows: [{ installed: true, form_schema: true }] };
      if (["begin", "commit", "rollback"].includes(sql) || sql.startsWith("select set_config")) {
        await forms.query(sql, values);
        return files.client.query(sql, values);
      }
      if ((ignore === "answers" && sql.startsWith("update public.member_forms set updated_at"))
          || (ignore === "attachment" && sql.startsWith("update public.member_form_files set encrypted_content"))
          || (ignore === "chunk" && sql.startsWith("update public.sensitive_form_chunks set envelope"))) return { rows: [] };
      if (sql.includes("public.member_form_files") || sql.includes("sensitive_retired_form_objects") || sql.includes("public.sensitive_form_chunks")) return files.client.query(sql, values);
      if (sql.includes("public.member_forms") || sql.includes("public.member_profiles") || sql.includes("private.form_content_digest")) return forms.query(sql, values);
      if (sql.includes("private.sensitive_retired_objects") && sql.includes("count(*)")) return { rows: [{ n: 0 }] };
      if (sql.startsWith("select * from public.") || sql.includes("public.member_case_files")
          || sql.includes("public.sensitive_case_chunks") || sql.includes("private.sensitive_retired_objects")) return { rows: [] };
      throw new Error(`unexpected ${sql}`);
    } };
    return { row, document, chunk, forms, files, client, ring, oldRing };
  }

  it("runs FMLA answers, attachments and staged envelopes through the hosted backfill/rewrap/verify path", async () => {
    const world = await hostedWorld({ plaintext: true });
    const options = { ring: world.oldRing, formStorage: world.files.storage };
    await runSensitiveMaintenance(world.client, {}, { ...options, mode: "backfill" });
    expect(world.row.encrypted_content.answers.keyVersion).toBe("v1");
    expect(world.document.encrypted_content.keyVersion).toBe("v1");
    const answers = structuredClone(world.row.encrypted_content.answers);
    const attachment = structuredClone(world.document.encrypted_content);
    const chunk = structuredClone(world.chunk.envelope);
    await runSensitiveMaintenance(world.client, {}, { ...options, ring: world.ring, oldRing: world.oldRing, mode: "rewrap" });
    expect(world.row.encrypted_content.answers).toMatchObject({ keyVersion: "v2", dataVersion: answers.dataVersion, payload: answers.payload });
    expect(world.document.encrypted_content).toMatchObject({ keyVersion: "v2", dataVersion: attachment.dataVersion, payload: attachment.payload });
    expect(world.chunk.envelope).toMatchObject({ keyVersion: "v2", dataVersion: chunk.dataVersion, payload: chunk.payload });
    await expect(runSensitiveMaintenance(world.client, {}, { ...options, ring: world.ring, mode: "verify" })).resolves.toBeDefined();
    expect(revealFormAnswers(world.row, world.ring)).toEqual({ reason: "Rotation proof" });
  });

  it.each(["answers", "attachment", "chunk"])("refuses hosted verification of a readable old-key %s envelope", async (kind) => {
    const world = await hostedWorld();
    if (kind !== "answers") await maintainSealedForms(world.forms, { ring: world.ring, oldRing: world.oldRing, mode: "rewrap" });
    const { maintainSealedFormFiles } = await import("../scripts/sensitive-form-maintenance.mjs");
    if (kind !== "attachment") await maintainSealedFormFiles(world.files.client, world.files.storage, { ring: world.ring, oldRing: world.oldRing, mode: "rewrap" });
    if (kind !== "chunk") world.chunk.envelope = rewrapSensitive(world.chunk.envelope, formChunkContext(world.document, 0), world.oldRing, world.ring);
    await expect(runSensitiveMaintenance(world.client, {}, { ring: world.ring, mode: "verify", formStorage: world.files.storage }))
      .rejects.toThrow("sensitive-form-key-rotation-required");
  });

  it.each(["answers", "attachment", "chunk"])("does not report a completed rotation when the %s rewrap was not installed", async (ignore) => {
    const world = await hostedWorld({ ignore });
    await expect(runSensitiveMaintenance(world.client, {}, { ring: world.ring, oldRing: world.oldRing, mode: "rewrap", formStorage: world.files.storage }))
      .rejects.toThrow("sensitive-form-key-rotation-required");
  });

  it("re-encrypts each attachment to a new object through the maintenance channel and retires the plaintext one", async () => {
    const { maintainSealedFormFiles } = await import("../scripts/sensitive-form-maintenance.mjs");
    const ring = ringFor("v1");
    const row = file("certification text");
    const original = row.object_name;
    const world = fileWorld([row]);
    expect(await maintainSealedFormFiles(world.client, world.storage, { ring })).toEqual({ processed: 1 });
    expect(row.object_name).not.toBe(original);
    expect(row.encrypted_content).toMatchObject({ purpose: "form-document", record: row.id });
    expect(world.objects.has(original)).toBe(false);
    expect(world.retired.size).toBe(0);
    expect(world.objects.get(row.object_name).toString()).not.toContain("certification text");
    await expect(maintainSealedFormFiles(fileWorld([row]).client, world.storage, { ring, mode: "verify" })).resolves.toEqual({ processed: 1 });
  });

  it("verify refuses an attachment that was never sealed", async () => {
    const { maintainSealedFormFiles } = await import("../scripts/sensitive-form-maintenance.mjs");
    const world = fileWorld([file("plain")]);
    await expect(maintainSealedFormFiles(world.client, world.storage, { ring: ringFor("v1"), mode: "verify" }))
      .rejects.toThrow("sensitive-document-backfill-required");
  });

  it("keeps verification failed after a committed pointer swap until the original plaintext is retired", async () => {
    const { maintainSealedFormFiles } = await import("../scripts/sensitive-form-maintenance.mjs");
    const ring = ringFor("v1"), row = file("retained plaintext");
    const world = fileWorld([row]);
    const original = row.object_name;
    const remove = world.storage.remove;
    world.storage.remove = async () => ({ error: "interrupted" });
    await expect(maintainSealedFormFiles(world.client, world.storage, { ring }))
      .rejects.toThrow("sensitive-document-retirement-pending");
    expect(row.object_name).not.toBe(original);
    expect(world.objects.has(original)).toBe(true);
    await expect(maintainSealedFormFiles(world.client, world.storage, { ring, mode: "verify" }))
      .rejects.toThrow("sensitive-document-retirement-pending");
    world.storage.remove = remove;
    await maintainSealedFormFiles(world.client, world.storage, { ring });
    await expect(maintainSealedFormFiles(world.client, world.storage, { ring, mode: "verify" })).resolves.toEqual({ processed: 1 });
  });
});

describe("sealed form CLI target identity", () => {
  const database = "postgresql://postgres:postgres@127.0.0.1:55999/postgres";
  it("accepts only the root API origin belonging to the validated disposable database", () => {
    expect(() => assertSealedFormStorageTarget(database, "http://127.0.0.1:55998", "synthetic-key")).not.toThrow();
  });
  it.each(["https://project.supabase.co", "http://127.0.0.1:55997", "http://localhost:55998", "http://127.0.0.1:55998/hosted", "http://u:p@127.0.0.1:55998", "http://127.0.0.1:55998?target=hosted"])("refuses an unbound Storage destination %s", (origin) => {
    expect(() => assertSealedFormStorageTarget(database, origin, "synthetic-key")).toThrow();
  });
});

describe("sealed forms gate window reopening", () => {
  function windowDatabase({ retired = 0, forms = [], missingLedger = false } = {}) {
    const statements = [];
    return { statements, async query(sql) {
      statements.push(sql);
      if (sql.includes("as closed")) return { rows: [{ closed: true, exposed: false }] };
      if (sql.includes("to_regclass")) return { rows: [{ installed: !missingLedger, form_schema: true }] };
      if (missingLedger && sql.includes("from private.sensitive_retired_form_objects")) throw new Error("missing retirement ledger");
      if (sql.includes("count(*)")) return { rows: [{ n: sql.includes("sensitive_retired_form_objects") ? retired : 0 }] };
      if (sql.includes("from public.member_forms where template_key")) return { rows: forms };
      return { rows: [] };
    } };
  }
  it("does not restore schema usage with pending retired form plaintext", async () => {
    const db = windowDatabase({ retired: 1 });
    await expect(openSensitiveWindow(db, {}, { ring: ringFor("v1"), formStorage: {} }))
      .rejects.toThrow("sensitive-document-retirement-pending");
    expect(db.statements.some((sql) => sql.includes("do $restore$"))).toBe(false);
  });
  it("does not treat a missing retirement ledger as a pre-FMLA schema", async () => {
    const db = windowDatabase({ missingLedger: true });
    await expect(openSensitiveWindow(db, {}, { ring: ringFor("v1"), formStorage: {} })).rejects.toThrow("missing retirement ledger");
    expect(db.statements.some((sql) => sql.includes("do $restore$"))).toBe(false);
  });
  it("requires form Storage and verifies form answers before restoring access", async () => {
    const missing = windowDatabase();
    await expect(openSensitiveWindow(missing, {}, { ring: ringFor("v1") })).rejects.toThrow("sensitive-form-storage-target-required");
    const plaintext = windowDatabase({ forms: [form({ organization_id: organization, answers: { reason: "legacy" } })] });
    await expect(openSensitiveWindow(plaintext, {}, { ring: ringFor("v1"), formStorage: {} })).rejects.toThrow("sensitive-data-backfill-required");
    expect(plaintext.statements.some((sql) => sql.includes("do $restore$"))).toBe(false);
    const safe = windowDatabase();
    await openSensitiveWindow(safe, {}, { ring: ringFor("v1"), formStorage: {} });
    expect(safe.statements.some((sql) => sql.includes("do $restore$"))).toBe(true);
  });
});
