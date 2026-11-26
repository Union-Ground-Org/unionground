import { createSensitiveServiceClient } from "./_lib/sensitiveSupabase.js";
import { createSensitiveStorage } from "./_lib/sensitiveStorage.js";
import { createClient } from "@supabase/supabase-js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, validateMutationOrigin } from "./_lib/http.js";
import { sensitiveKeyring, encryptSensitive } from "./_lib/sensitiveDataCrypto.js";
import { SENSITIVE_DOCUMENT_MAX_BYTES, SENSITIVE_DOCUMENT_CHUNK_BYTES, SENSITIVE_DOCUMENT_FULL_READ_MAX_BYTES } from "./_lib/sensitiveCaseDocuments.js";
import { assembleFormChunks, decryptFormDocument, encryptFormDocument, formChunkContext } from "./_lib/sensitiveFormDocuments.js";

// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022 (#5747): sealed
// FMLA form attachments, the api/sensitive-case-files.js flow over
// member_form_files. The browser registers the file, this route encrypts and
// stores the ciphertext, then the private-upload inspector and
// confirm_member_form_file run unchanged.
export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "not-authorized" });
  const { action, fileId, bytes, index, offset } = request.body || {};
  if (!["upload", "chunk", "finish", "read", "remove"].includes(action) || !/^[0-9a-f-]{36}$/.test(fileId || "")) return json(response, 400, { error: "invalid-input" });
  const backend = resolveSupabaseBackend(request);
  // Union Ground has no member PIN sign-in, so no session is a restricted PIN
  // session; the database policies still close form documents to one.
  if (action === "remove") return removeFormFile(response, backend, token, fileId);
  try {
    const ring = sensitiveKeyring(backend.surface);
    const client = createClient(backend.url, backend.publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    if (["upload", "chunk", "finish"].includes(action)) {
      if (action !== "finish" && (typeof bytes !== "string" || bytes.length > Math.ceil(SENSITIVE_DOCUMENT_CHUNK_BYTES / 3) * 4)) return json(response, 413, { error: "sensitive-document-chunk-too-large" });
      const target = await client.rpc("sensitive_form_upload_target", { p_file_id: fileId });
      if (target.error || !target.data) return json(response, 403, { error: "not-authorized" });
      if (target.data.size_bytes < 1 || target.data.size_bytes > SENSITIVE_DOCUMENT_MAX_BYTES) return json(response, 413, { error: "sensitive-document-max-10-mib" });
      const service = createSensitiveServiceClient(backend.url, backend.serviceRoleKey);
      if (action === "chunk") {
        if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(target.data.size_bytes / SENSITIVE_DOCUMENT_CHUNK_BYTES)) return json(response, 400, { error: "invalid-input" });
        const part = Buffer.from(bytes, "base64");
        try {
          if (part.toString("base64") !== bytes || part.length !== Math.min(SENSITIVE_DOCUMENT_CHUNK_BYTES, target.data.size_bytes - index * SENSITIVE_DOCUMENT_CHUNK_BYTES)) return json(response, 400, { error: "invalid-input" });
          // The chunk table has no foreign key; expired fragments go here.
          await service.from("sensitive_form_chunks").delete().lt("expires_at", new Date().toISOString());
          const envelope = encryptSensitive(part, formChunkContext(target.data, index), ring);
          const saved = await service.from("sensitive_form_chunks").upsert({ file_id: fileId, chunk_index: index, envelope, expires_at: new Date(Date.now() + 3600000).toISOString() });
          if (saved.error) throw new Error("sensitive-document-chunk-refused");
          return json(response, 200, { fileId, status: "chunk", index });
        } finally { part.fill(0); }
      }
      const plaintext = action === "finish" ? await assembleFormChunks(service, target.data, ring) : Buffer.from(bytes, "base64");
      if (action === "upload" && plaintext.toString("base64") !== bytes) { plaintext.fill(0); return json(response, 400, { error: "invalid-input" }); }
      let encrypted;
      try { encrypted = encryptFormDocument(plaintext, target.data, ring); } finally { plaintext.fill(0); }
      const saved = await service.rpc("set_sensitive_form_envelope", { p_file_id: fileId, p_envelope: encrypted.envelope });
      if (saved.error) throw new Error("sensitive-document-upload-unavailable");
      if (saved.data !== true) return json(response, 409, { error: "sensitive-document-restart-upload" });
      const uploaded = await service.storage.from("member-form-files").upload(target.data.object_name, encrypted.ciphertext,
        { contentType: target.data.mime_type, upsert: false });
      if (uploaded.error) throw new Error("sensitive-document-upload-unavailable");
      if (action === "finish") await service.from("sensitive_form_chunks").delete().eq("file_id", fileId);
      return json(response, 200, { fileId, status: "uploaded" });
    }
    // RLS authorizes the visible attachment and its form; Storage's caller-JWT
    // download independently checks the current scan verdict on every request.
    const fullRead = offset === undefined || offset === "full";
    if (!fullRead && (!Number.isInteger(offset) || offset < 0 || offset >= SENSITIVE_DOCUMENT_MAX_BYTES || offset % SENSITIVE_DOCUMENT_CHUNK_BYTES !== 0)) return json(response, 400, { error: "invalid-input" });
    const result = await client.from("member_form_files").select("id,size_bytes,encrypted_content,object_name,mime_type,member_forms!inner(organization_id)").eq("id", fileId).single();
    if (result.error || !result.data?.encrypted_content) return json(response, 403, { error: "not-authorized" });
    let download;
    try { download = await createSensitiveStorage(backend.url, backend.publishableKey, { token, bucket: "member-form-files" }).download(result.data.object_name); }
    catch { return json(response, 503, { error: "sensitive-document-unavailable" }); }
    if (download?.error) {
      if (["absent", "denied"].includes(download.failure)) {
        const verdict = await client.rpc("sensitive_form_read_current", { p_file_id: fileId });
        if (!verdict.error && verdict.data === false) return json(response, 409, { error: "file-recheck-required" });
      }
      return json(response, 503, { error: "sensitive-document-unavailable" });
    }
    if (!download?.data || typeof download.data.arrayBuffer !== "function") return json(response, 503, { error: "sensitive-document-unavailable" });
    let stored;
    try { stored = Buffer.from(await download.data.arrayBuffer()); }
    catch { return json(response, 503, { error: "sensitive-document-unavailable" }); }
    const plaintext = decryptFormDocument(stored,
      { ...result.data, organization_id: result.data.member_forms.organization_id }, ring);
    try {
      response.status(200).setHeader("Content-Type", result.data.mime_type);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Sensitive-Total-Bytes", String(plaintext.length));
      response.setHeader("X-Sensitive-Data-Version", result.data.encrypted_content.dataVersion);
      const window = fullRead ? 0 : offset;
      response.end(Buffer.from(fullRead && plaintext.length <= SENSITIVE_DOCUMENT_FULL_READ_MAX_BYTES
        ? plaintext : plaintext.subarray(window, window + SENSITIVE_DOCUMENT_CHUNK_BYTES)));
    } finally { plaintext.fill(0); }
  } catch {
    return json(response, 503, { error: "sensitive-data-key-or-backfill-unavailable" });
  }
}

// BUG-UG-FORM-FILE-WITH-UNFINISHED-SAFETY-CHECK-CANNOT-BE-REMOVED-20261112
// (#8569): every form attachment, sealed or not, is removed here. A file whose
// safety check never finished is unconfirmed, and row security hides an
// unconfirmed object from the member's own Storage delete, which then answers
// without an error and removes nothing. So the member's own token marks the
// file for removal through request_member_form_file_removal (their own file on
// a draft or returned form only); the service role deletes exactly the object
// that call names, never a name from the request; and finalize, as the member,
// retires the row only once the bytes are gone. Any failure leaves the mark in
// place for a retry and is never reported as a removal. Nothing is read.
async function removeFormFile(response, backend, token, fileId) {
  const client = createClient(backend.url, backend.publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const requested = await client.rpc("request_member_form_file_removal", { p_file_id: fileId });
    const bucket = requested.data?.bucketId ?? requested.data?.bucket_id;
    const objectName = requested.data?.objectName ?? requested.data?.object_name;
    if (requested.error || bucket !== "member-form-files" || typeof objectName !== "string" || !objectName) {
      return json(response, 403, { error: "not-authorized" });
    }
    const removed = await createSensitiveServiceClient(backend.url, backend.serviceRoleKey).storage.from(bucket).remove([objectName]);
    if (removed.error && !/not.?found/i.test(removed.error.message || "")) return json(response, 503, { error: "form-file-removal-unavailable" });
    const finalized = await client.rpc("finalize_member_form_file_removal", { p_file_id: fileId });
    if (finalized.error || finalized.data?.id !== fileId || finalized.data?.deleted !== true) {
      return json(response, 503, { error: "form-file-removal-unavailable" });
    }
    return json(response, 200, { fileId, status: "removed", receipt: finalized.data });
  } catch {
    return json(response, 503, { error: "form-file-removal-unavailable" });
  }
}
