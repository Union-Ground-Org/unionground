import { createSensitiveServiceClient } from "./_lib/sensitiveSupabase.js";
import { createSensitiveStorage } from "./_lib/sensitiveStorage.js";
import { createClient } from "@supabase/supabase-js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, validateMutationOrigin } from "./_lib/http.js";
import { sensitiveKeyring, encryptSensitive } from "./_lib/sensitiveDataCrypto.js";
import { decryptCaseDocument, encryptCaseDocument, SENSITIVE_DOCUMENT_MAX_BYTES, SENSITIVE_DOCUMENT_CHUNK_BYTES, SENSITIVE_DOCUMENT_FULL_READ_MAX_BYTES, chunkContext, assembleCaseChunks } from "./_lib/sensitiveCaseDocuments.js";

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "not-authorized" });
  const { action, fileId, bytes, index, offset } = request.body || {};
  if (!["upload", "chunk", "finish", "read"].includes(action) || !/^[0-9a-f-]{36}$/.test(fileId || "")) return json(response, 400, { error: "invalid-input" });
  const backend = resolveSupabaseBackend(request);
  try {
    const ring = sensitiveKeyring(backend.surface);
    const client = createClient(backend.url, backend.publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    if (["upload", "chunk", "finish"].includes(action)) {
      if (action !== "finish" && (typeof bytes !== "string" || bytes.length > Math.ceil(SENSITIVE_DOCUMENT_CHUNK_BYTES / 3) * 4)) return json(response, 413, { error: "sensitive-document-chunk-too-large" });
      const target = await client.rpc("sensitive_case_upload_target", { p_file_id: fileId });
      if (target.error || !target.data) return json(response, 403, { error: "not-authorized" });
      if (target.data.size_bytes < 1 || target.data.size_bytes > SENSITIVE_DOCUMENT_MAX_BYTES) return json(response, 413, { error: "sensitive-document-max-10-mib" });
      const service = createSensitiveServiceClient(backend.url, backend.serviceRoleKey);
      if (action === "chunk") {
        if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(target.data.size_bytes / SENSITIVE_DOCUMENT_CHUNK_BYTES)) return json(response, 400, { error: "invalid-input" });
        const part = Buffer.from(bytes, "base64");
        try {
          if (part.toString("base64") !== bytes || part.length !== Math.min(SENSITIVE_DOCUMENT_CHUNK_BYTES, target.data.size_bytes - index * SENSITIVE_DOCUMENT_CHUNK_BYTES)) return json(response, 400, { error: "invalid-input" });
          const envelope = encryptSensitive(part, chunkContext(target.data, index), ring);
          const saved = await service.from("sensitive_case_chunks").upsert({ file_id: fileId, chunk_index: index, envelope, expires_at: new Date(Date.now() + 3600000).toISOString() });
          if (saved.error) throw new Error("sensitive-document-chunk-refused");
          return json(response, 200, { fileId, status: "chunk", index });
        } finally { part.fill(0); }
      }
      const plaintext = action === "finish" ? await assembleCaseChunks(service, target.data, ring) : Buffer.from(bytes, "base64");
      if (action === "upload" && plaintext.toString("base64") !== bytes) { plaintext.fill(0); return json(response, 400, { error: "invalid-input" }); }
      let encrypted;
      try { encrypted = encryptCaseDocument(plaintext, target.data, ring); } finally { plaintext.fill(0); }
      const saved = await service.rpc("set_sensitive_case_envelope", { p_file_id: fileId, p_envelope: encrypted.envelope });
      if (saved.error) throw new Error("sensitive-document-upload-unavailable");
      if (saved.data !== true) return json(response, 409, { error: "sensitive-document-restart-upload" });
      const uploaded = await service.storage.from("case-files").upload(target.data.object_name, encrypted.ciphertext,
        { contentType: target.data.mime_type, upsert: false });
      if (uploaded.error) throw new Error("sensitive-document-upload-unavailable");
      if (action === "finish") await service.from("sensitive_case_chunks").delete().eq("file_id", fileId);
      return json(response, 200, { fileId, status: "uploaded" });
    }
    // RLS authorizes the visible attachment and its case; Storage's caller-JWT
    // download independently checks the current scan verdict on every request.
    const fullRead = offset === undefined || offset === "full";
    if (!fullRead && (!Number.isInteger(offset) || offset < 0 || offset >= SENSITIVE_DOCUMENT_MAX_BYTES || offset % SENSITIVE_DOCUMENT_CHUNK_BYTES !== 0)) return json(response, 400, { error: "invalid-input" });
    const result = await client.from("member_case_files").select("id,size_bytes,encrypted_content,object_name,mime_type,member_cases!inner(organization_id)").eq("id", fileId).single();
    if (result.error || !result.data) return json(response, 403, { error: "not-authorized" });
    let download;
    try { download = await createSensitiveStorage(backend.url, backend.publishableKey, { token }).download(result.data.object_name); }
    catch { return json(response, 503, { error: "sensitive-document-unavailable" }); }
    if (download?.error) {
      // A 4xx alone cannot prove an expired verdict. Recheck the current
      // ledger through caller RLS without starting an inspection attempt.
      if (["absent", "denied"].includes(download.failure)) {
        const verdict = await client.rpc("sensitive_case_read_current", { p_file_id: fileId });
        if (!verdict.error && verdict.data === false) return json(response, 409, { error: "file-recheck-required" });
      }
      return json(response, 503, { error: "sensitive-document-unavailable" });
    }
    if (!download?.data || typeof download.data.arrayBuffer !== "function") return json(response, 503, { error: "sensitive-document-unavailable" });
    let stored;
    try { stored = Buffer.from(await download.data.arrayBuffer()); }
    catch { return json(response, 503, { error: "sensitive-document-unavailable" }); }
    const plaintext = decryptCaseDocument(stored,
      { ...result.data, organization_id: result.data.member_cases.organization_id }, ring);
    try {
      response.status(200).setHeader("Content-Type", result.data.mime_type);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Sensitive-Total-Bytes", String(plaintext.length));
      response.setHeader("X-Sensitive-Data-Version", result.data.encrypted_content.dataVersion);
      // A whole-file body over the platform's buffered-response cap would be
      // refused, so oversized documents answer a full read with the first
      // window and the caller resumes the offset loop from there.
      const window = fullRead ? 0 : offset;
      response.end(Buffer.from(fullRead && plaintext.length <= SENSITIVE_DOCUMENT_FULL_READ_MAX_BYTES
        ? plaintext : plaintext.subarray(window, window + SENSITIVE_DOCUMENT_CHUNK_BYTES)));
    } finally { plaintext.fill(0); }
  } catch {
    return json(response, 503, { error: "sensitive-data-key-or-backfill-unavailable" });
  }
}
