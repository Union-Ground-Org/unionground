import { randomUUID } from "node:crypto";
import { encryptCaseDocument, decryptCaseDocument, documentContext } from "../api/_lib/sensitiveCaseDocuments.js";
import { rewrapSensitive, rotationReadKeyring } from "../api/_lib/sensitiveDataCrypto.js";

// Only the Storage API's structured object-absence verdict is authoritative.
// Generic HTTP 404s (proxy routes), auth failures and unknown responses are not.
async function downloadObject(storage, name) {
  try {
    const result = await storage.download(name);
    if (result?.error) {
      if (result.failure === "absent" && !result.data) return null;
      throw new Error("unavailable");
    }
    if (!result?.data || !result.data.size || typeof result.data.arrayBuffer !== "function") throw new Error("unavailable");
    return Buffer.from(await result.data.arrayBuffer());
  } catch { throw new Error("sensitive-document-storage-unavailable"); }
}

// Immutable new object + locked pointer swap. Interrupted uploads remain only
// encrypted orphans; old plaintext is retained in the private retirement ledger
// until the pointer commit is durable and Storage deletion is confirmed.
export async function maintainSensitiveDocuments(client, storage, { ring, oldRing = ring, mode = "backfill" }) {
  if (!["backfill", "rewrap", "verify"].includes(mode)) throw new Error("sensitive-maintenance-invalid-options");
  const readRing = mode === "rewrap" ? rotationReadKeyring(oldRing, ring) : ring;
  let after = "00000000-0000-0000-0000-000000000000", processed = 0;
  for (;;) {
    await client.query("begin");
    try {
      const result = await client.query(`select f.*,c.organization_id from public.member_case_files f
        join public.member_cases c on c.id=f.case_id where f.id > $1 order by f.id limit 1 for update of f`, [after]);
      const row = result.rows[0];
      if (!row) { await client.query("commit"); break; }
      after = row.id;
      const stored = await downloadObject(storage, row.object_name);
      if (stored === null) {
        // A never-uploaded pending checkpoint carries no legacy bytes.
        if (!row.confirmed_at && !row.encrypted_content) { await client.query("commit"); continue; }
        throw new Error("sensitive-document-unavailable");
      }
      let plaintext;
      try {
        plaintext = row.encrypted_content ? decryptCaseDocument(stored, row, readRing) : stored;
        if (mode === "verify" && !row.encrypted_content) throw new Error("sensitive-document-backfill-required");
        if (mode === "rewrap" && row.encrypted_content?.keyVersion !== ring.active) {
          const complete = { ...row.encrypted_content, payload: { ...row.encrypted_content.payload, ciphertext: stored.toString("base64") } };
          const moved = rewrapSensitive(complete, documentContext(row), readRing, ring);
          delete moved.payload.ciphertext;
          await client.query("update public.member_case_files set encrypted_content=$1 where id=$2", [moved,row.id]);
        } else if (!row.encrypted_content) {
          const encrypted = encryptCaseDocument(plaintext,row,ring);
          const nextName = `${row.object_name}.enc-${randomUUID()}`;
          const uploaded = await storage.upload(nextName,encrypted.ciphertext,{ contentType: row.mime_type, upsert: false });
          if (uploaded.error) throw new Error("sensitive-document-copy-failed");
          const check = await storage.download(nextName);
          if (check.error) throw new Error("sensitive-document-copy-failed");
          const verified = decryptCaseDocument(Buffer.from(await check.data.arrayBuffer()), { ...row, encrypted_content: encrypted.envelope }, ring);
          try { if (!verified.equals(plaintext)) throw new Error("sensitive-document-copy-failed"); }
          finally { verified.fill(0); }
          await client.query("insert into private.sensitive_retired_objects(object_name) values($1) on conflict do nothing", [row.object_name]);
          await client.query("update public.member_case_files set object_name=$1,encrypted_content=$2 where id=$3", [nextName,encrypted.envelope,row.id]);
        }
      } finally { plaintext?.fill(0); stored.fill(0); }
      await client.query("commit"); processed += 1;
    } catch (error) {
      await client.query("rollback");
      if (error.message === "sensitive-document-storage-unavailable") throw error;
      // eslint-disable-next-line preserve-caught-error -- Upstream errors can contain private object paths or payloads.
      throw new Error("sensitive-document-maintenance-rolled-back");
    }
  }
  if (mode === "backfill") {
    for (;;) {
      const pending = await client.query("select object_name from private.sensitive_retired_objects order by object_name limit 100");
      if (!pending.rows.length) break;
      for (const row of pending.rows) {
        const removed = await storage.remove([row.object_name]);
        if (removed.error) throw new Error("sensitive-document-retirement-pending");
        const old = await downloadObject(storage, row.object_name);
        if (old !== null) { old.fill(0); throw new Error("sensitive-document-retirement-pending"); }
        await client.query("delete from private.sensitive_retired_objects where object_name=$1", [row.object_name]);
      }
    }
  }
  return { processed };
}
