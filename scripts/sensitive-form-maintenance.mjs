import pg from "pg";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SEALED_FORM_TEMPLATES, filledFormKeys, revealFormAnswers, sealFormAnswers } from "../api/_lib/sensitiveContent.js";
import { decryptFormDocument, encryptFormDocument, formChunkContext, formDocumentContext } from "../api/_lib/sensitiveFormDocuments.js";
import { decryptSensitive, rewrapSensitive, rotationReadKeyring, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { createSensitiveStorage } from "../api/_lib/sensitiveStorage.js";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { validateScanTarget } from "./lib/database-assurance-policy.mjs";

// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022 (#5747): seals the
// FMLA rows written before the sealed-answers migration, rewraps them on key
// rotation, and verifies that none is left in plaintext. It runs only in the
// closed maintenance window (owner default D5), one locked row per
// transaction, through the audited app.sensitive_maintenance channel. A row
// already submitted keeps its frozen content digest ("legacyDigest"), so its
// signatures and approved artifact digest stay valid (owner default D2).
const TEMPLATES = [...SEALED_FORM_TEMPLATES];
const FROZEN_STATUSES = new Set(["submitted", "in_review", "approved"]);
const ZERO = "00000000-0000-0000-0000-000000000000";
const contentless = (answers) => Object.keys(answers || {}).every((key) => key === "seedSequence");

export function assertSealedFormStorageTarget(databaseUrl, origin, serviceKey) {
  if (typeof serviceKey !== "string" || !serviceKey) throw new Error("sensitive-form-storage-target-required");
  validateScanTarget(databaseUrl, { DB_URL: databaseUrl, API_URL: origin, ANON_KEY: serviceKey, SERVICE_ROLE_KEY: serviceKey });
}

export async function assertNoRetiredFormObjects(client) {
  const pending = await client.query("select count(*)::integer n from private.sensitive_retired_form_objects");
  if (!Number.isSafeInteger(pending.rows[0]?.n) || pending.rows[0].n !== 0) throw new Error("sensitive-document-retirement-pending");
}

async function formOrganization(client, row) {
  if (row.organization_id) return row.organization_id;
  const result = await client.query(`select c.organization_id from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id where p.id = $1 and c.organization_id is not null`, [row.user_id]);
  if (result.rows.length !== 1) throw new Error("sensitive-form-organization-unresolved");
  return result.rows[0].organization_id;
}

async function maintenanceUpdate(client, envelopes, sql, values) {
  await client.query("select set_config('app.sensitive_maintenance','on',true)");
  await client.query("select set_config('app.sensitive_envelopes',$1,true)", [JSON.stringify(envelopes)]);
  await client.query(sql, values);
}

export async function maintainSealedForms(client, { ring, mode = "backfill", oldRing = ring, limit = 100, cursor = ZERO }) {
  if (!["backfill", "rewrap", "verify"].includes(mode) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("sensitive-maintenance-invalid-options");
  const readRing = mode === "rewrap" ? rotationReadKeyring(oldRing, ring) : ring;
  let after = cursor, processed = 0, exhausted = true;
  for (let index = 0; index < limit; index += 1) {
    await client.query("begin");
    try {
      const result = await client.query(`select id,user_id,template_key,status,answers,organization_id,encrypted_content
        from public.member_forms where template_key = any($2) and id > $1 order by id limit 1 for update`, [after, TEMPLATES]);
      const row = result.rows[0];
      if (!row) { await client.query("commit"); break; }
      after = row.id;
      if (row.encrypted_content?.answers && row.answers?.sealed !== true) throw new Error("sensitive-form-envelope-marker-required");
      // A row is sealed only with its envelope; a legacy plaintext answer
      // named "sealed" still needs the backfill (#6363 round 1).
      if (row.answers?.sealed === true && row.encrypted_content?.answers) {
        // Authenticates the stored envelope; the opened answers are discarded.
        revealFormAnswers(row, readRing);
        if (mode === "verify" && row.encrypted_content.answers.keyVersion !== ring.active) throw new Error("sensitive-form-key-rotation-required");
        if (mode === "rewrap" && row.encrypted_content.answers.keyVersion !== ring.active) {
          const context = { organization: row.organization_id, record: row.id, field: "answers", purpose: "member_forms" };
          const moved = rewrapSensitive(row.encrypted_content.answers, context, readRing, ring);
          await maintenanceUpdate(client, { answers: moved }, "update public.member_forms set updated_at = updated_at where id = $1", [row.id]);
        }
      } else if (contentless(row.answers)) {
        // An empty or seed-only draft still needs its organization, or
        // prepare_sealed_form refuses to resume it (#5827 r1s3).
        if (!row.organization_id) {
          if (mode !== "backfill") throw new Error("sensitive-data-backfill-required");
          const organization = await formOrganization(client, row);
          await maintenanceUpdate(client, {}, "update public.member_forms set organization_id = $1 where id = $2", [organization, row.id]);
        }
      } else {
        if (mode !== "backfill") throw new Error("sensitive-data-backfill-required");
        const organization = await formOrganization(client, row);
        const legacyDigest = FROZEN_STATUSES.has(row.status)
          ? (await client.query("select private.form_content_digest($1) as digest", [row.id])).rows[0]?.digest : null;
        if (FROZEN_STATUSES.has(row.status) && !legacyDigest) throw new Error("sensitive-form-digest-unavailable");
        const envelope = sealFormAnswers(row.answers, { id: row.id, organization_id: organization }, ring);
        const marker = { sealed: true, filled: filledFormKeys(row.answers), dataVersion: envelope.dataVersion, ...(legacyDigest ? { legacyDigest } : {}) };
        await maintenanceUpdate(client, { answers: envelope },
          "update public.member_forms set organization_id = $1, answers = $2 where id = $3", [organization, marker, row.id]);
      }
      await client.query("commit"); processed += 1;
      if (index === limit - 1) exhausted = false;
    } catch (error) {
      await client.query("rollback");
      // eslint-disable-next-line preserve-caught-error -- Upstream errors can contain private answers.
      throw new Error(error?.message?.startsWith("sensitive-") ? error.message : "sensitive-form-maintenance-rolled-back");
    }
  }
  return { processed, cursor: after, exhausted };
}

// Attachments of sealed forms: an immutable encrypted copy, a verified pointer
// swap, then retirement of the plaintext object, as for case documents. The
// new object needs a fresh inspection verdict before it can be read or filed.
export async function maintainSealedFormFiles(client, storage, { ring, oldRing = ring, mode = "backfill" }) {
  if (!["backfill", "rewrap", "verify"].includes(mode)) throw new Error("sensitive-maintenance-invalid-options");
  const readRing = mode === "rewrap" ? rotationReadKeyring(oldRing, ring) : ring;
  let after = ZERO, processed = 0;
  for (;;) {
    await client.query("begin");
    try {
      const result = await client.query(`select ff.*, f.organization_id from public.member_form_files ff
        join public.member_forms f on f.id = ff.form_id where f.template_key = any($2) and ff.id > $1
        order by ff.id limit 1 for update of ff`, [after, TEMPLATES]);
      const row = result.rows[0];
      if (!row) { await client.query("commit"); break; }
      after = row.id;
      if (!row.organization_id) throw new Error("sensitive-data-backfill-required");
      const download = await storage.download(row.object_name);
      if (download?.error) {
        if (download.failure === "absent" && !row.confirmed_at && !row.encrypted_content) { await client.query("commit"); continue; }
        throw new Error("sensitive-document-storage-unavailable");
      }
      const stored = Buffer.from(await download.data.arrayBuffer());
      let plaintext;
      try {
        plaintext = row.encrypted_content ? decryptFormDocument(stored, row, readRing) : stored;
        if (mode === "verify" && !row.encrypted_content) throw new Error("sensitive-document-backfill-required");
        if (mode === "verify" && row.encrypted_content.keyVersion !== ring.active) throw new Error("sensitive-form-key-rotation-required");
        if (mode === "rewrap" && row.encrypted_content && row.encrypted_content.keyVersion !== ring.active) {
          const complete = { ...row.encrypted_content, payload: { ...row.encrypted_content.payload, ciphertext: stored.toString("base64") } };
          const moved = rewrapSensitive(complete, formDocumentContext(row), readRing, ring);
          delete moved.payload.ciphertext;
          await maintenanceUpdate(client, {}, "update public.member_form_files set encrypted_content = $1 where id = $2", [moved, row.id]);
        } else if (mode === "backfill" && !row.encrypted_content) {
          const encrypted = encryptFormDocument(plaintext, row, ring);
          const nextName = `${row.object_name}.enc-${randomUUID()}`;
          const uploaded = await storage.upload(nextName, encrypted.ciphertext, { contentType: row.mime_type, upsert: false });
          if (uploaded.error) throw new Error("sensitive-document-copy-failed");
          const check = await storage.download(nextName);
          if (check.error) throw new Error("sensitive-document-copy-failed");
          const verified = decryptFormDocument(Buffer.from(await check.data.arrayBuffer()), { ...row, encrypted_content: encrypted.envelope }, ring);
          try { if (!verified.equals(plaintext)) throw new Error("sensitive-document-copy-failed"); }
          finally { verified.fill(0); }
          await client.query("insert into private.sensitive_retired_form_objects(object_name) values($1) on conflict do nothing", [row.object_name]);
          await maintenanceUpdate(client, {}, "update public.member_form_files set object_name = $1, encrypted_content = $2 where id = $3", [nextName, encrypted.envelope, row.id]);
        }
      } finally { plaintext?.fill(0); stored.fill(0); }
      await client.query("commit"); processed += 1;
    } catch (error) {
      await client.query("rollback");
      // eslint-disable-next-line preserve-caught-error -- Upstream errors can contain private object paths or payloads.
      throw new Error(error?.message?.startsWith("sensitive-") ? error.message : "sensitive-form-file-maintenance-rolled-back");
    }
  }
  if (mode === "verify") await assertNoRetiredFormObjects(client);
  if (mode === "backfill") {
    // Retire the replaced plaintext objects, only once each pointer swap is
    // committed; a pending row blocks reopening the window (#5827 r1s2).
    for (;;) {
      const pending = await client.query("select object_name from private.sensitive_retired_form_objects order by object_name limit 100");
      if (!pending.rows.length) break;
      for (const { object_name: name } of pending.rows) {
        const removed = await storage.remove([name]);
        if (removed?.error) throw new Error("sensitive-document-retirement-pending");
        const old = await storage.download(name);
        if (!(old?.error && old.failure === "absent")) throw new Error("sensitive-document-retirement-pending");
        await client.query("delete from private.sensitive_retired_form_objects where object_name = $1", [name]);
      }
    }
  }
  return { processed };
}

// Staged uploads are envelopes too. They deliberately have no FK, so even an
// orphan must be visited until expiry. Its organization is authenticated by
// the envelope MAC; the row pins the file and chunk purpose independently.
async function maintainSealedFormChunks(client, { ring, oldRing = ring, mode }) {
  const readRing = mode === "rewrap" ? rotationReadKeyring(oldRing, ring) : ring;
  await client.query("delete from public.sensitive_form_chunks where expires_at < clock_timestamp()");
  let file = ZERO, index = -1, processed = 0;
  for (;;) {
    await client.query("begin");
    try {
      const result = await client.query(`select file_id,chunk_index,envelope from public.sensitive_form_chunks
        where (file_id,chunk_index) > ($1::uuid,$2::integer)
        order by file_id,chunk_index limit 1 for update`, [file, index]);
      const row = result.rows[0];
      if (!row) { await client.query("commit"); break; }
      file = row.file_id; index = row.chunk_index;
      const context = formChunkContext({ id: file, organization_id: row.envelope?.organization }, index);
      const verified = decryptSensitive(row.envelope, context, readRing);
      verified.fill(0);
      if (mode === "verify" && row.envelope.keyVersion !== ring.active) throw new Error("sensitive-form-key-rotation-required");
      if (mode === "rewrap" && row.envelope.keyVersion !== ring.active) {
        const moved = rewrapSensitive(row.envelope, context, readRing, ring);
        await client.query("update public.sensitive_form_chunks set envelope = $1 where file_id = $2 and chunk_index = $3", [moved, file, index]);
      }
      await client.query("commit"); processed += 1;
    } catch (error) {
      await client.query("rollback");
      // eslint-disable-next-line preserve-caught-error -- Upstream errors can contain private chunk metadata.
      throw new Error(error?.message?.startsWith("sensitive-") ? error.message : "sensitive-form-chunk-maintenance-rolled-back");
    }
  }
  return { processed };
}

// Both operator entry points sweep the same surface. Re-read committed rows
// after writes: a skipped/ineffective rewrap cannot report completion merely
// because the retained old key can still decrypt it.
export async function runSealedFormMaintenance(client, storage, options) {
  const run = async (mode) => {
    let batch, cursor = ZERO, forms = 0;
    do {
      batch = await maintainSealedForms(client, { ...options, mode, cursor });
      cursor = batch.cursor; forms += batch.processed;
    } while (!batch.exhausted);
    const files = await maintainSealedFormFiles(client, storage, { ...options, mode });
    const chunks = await maintainSealedFormChunks(client, { ...options, mode });
    return { forms, files: files.processed, chunks: chunks.processed };
  };
  const mode = options.mode ?? "backfill";
  const result = await run(mode);
  if (mode !== "verify") await run("verify");
  return result;
}

async function main() {
  // Disposable-only like scripts/sensitive-data-maintenance.mjs: the hosted
  // run belongs to the reviewed maintenance window, never a flag override.
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  // Validate both destinations before constructing clients or mutating rows.
  assertSealedFormStorageTarget(connectionString, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const mode = process.argv[2];
  if (!["backfill", "rewrap", "verify"].includes(mode)) throw new Error("usage: sensitive-form-maintenance.mjs backfill|rewrap|verify");
  const ring = sensitiveKeyring();
  const oldRing = mode === "rewrap" ? sensitiveKeyring("saas", {
    SENSITIVE_DATA_KEYS: process.env.SENSITIVE_DATA_OLD_KEYS,
    SENSITIVE_DATA_ACTIVE_KEY: process.env.SENSITIVE_DATA_OLD_ACTIVE_KEY,
    SENSITIVE_DATA_REVOKED_ORGANIZATIONS: process.env.SENSITIVE_DATA_REVOKED_ORGANIZATIONS,
  }) : ring;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Attachments are part of every mode (#5827 r1g1, r1s4): a run that cannot
    // reach the disposable Storage target refuses instead of reporting success.
    const storage = createSensitiveStorage(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { bucket: "member-form-files" });
    const result = await runSealedFormMaintenance(client, storage, { ring, oldRing, mode });
    console.log(JSON.stringify({ processed: result.forms, files: result.files, chunks: result.chunks }));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("sensitive-form-maintenance-refused; inspect configuration and migration readiness without payload logging"); process.exitCode = 1; });
}
