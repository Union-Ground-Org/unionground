import { createSensitiveServiceClient } from "./sensitiveSupabase.js";
import { decryptSensitive, encryptSensitive, sensitiveKeyring } from "./sensitiveDataCrypto.js";

export const SENSITIVE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export function documentContext(row) {
  return { organization: row.organization_id, record: row.id, field: "bytes", purpose: "case-document" };
}
export function encryptCaseDocument(bytes, row, ring) {
  if (bytes.length !== Number(row.size_bytes) || bytes.length < 1 || bytes.length > SENSITIVE_DOCUMENT_MAX_BYTES) throw new Error("sensitive-document-size");
  const full = encryptSensitive(bytes, documentContext(row), ring);
  const ciphertext = Buffer.from(full.payload.ciphertext, "base64");
  const envelope = { ...full, payload: { nonce: full.payload.nonce, tag: full.payload.tag } };
  return { ciphertext, envelope };
}
export function decryptCaseDocument(bytes, row, ring) {
  if (bytes.length !== Number(row.size_bytes) || !row.encrypted_content) throw new Error("sensitive-document-unavailable");
  const envelope = { ...row.encrypted_content, payload: { ...row.encrypted_content.payload, ciphertext: bytes.toString("base64") } };
  return decryptSensitive(envelope, documentContext(row), ring);
}
// Invoked ONLY after the inspector's caller-authenticated authorization RPC.
export async function decryptInspectedCaseDocument(backend, target, bytes) {
  const service = createSensitiveServiceClient(backend.url, backend.serviceRoleKey);
  const result = await service.rpc("sensitive_case_inspection_metadata", { p_file_id: target.fileId, p_attempt_id: target.attemptId });
  if (result.error || !result.data || result.data.id !== target.fileId
    || result.data.object_name !== target.objectName) throw new Error("sensitive-document-unavailable");
  return decryptCaseDocument(bytes, result.data, sensitiveKeyring(backend.surface));
}

export const SENSITIVE_DOCUMENT_CHUNK_BYTES = 1024 * 1024;
// Vercel Functions reject a buffered response body over 4.5 MB, so a whole-file
// read is only served up to this bound; larger documents fall back to windows.
export const SENSITIVE_DOCUMENT_FULL_READ_MAX_BYTES = 4 * SENSITIVE_DOCUMENT_CHUNK_BYTES;
export function chunkContext(row, index) {
  if (!Number.isInteger(index) || index < 0 || index > 9) throw new Error("sensitive-document-chunk-refused");
  return { organization: row.organization_id, record: row.id, field: "bytes", purpose: `case-document-chunk-${String.fromCharCode(97 + index)}` };
}
export async function assembleCaseChunks(service, row, ring) {
  const result = await service.from("sensitive_case_chunks").select("chunk_index,envelope")
    .eq("file_id", row.id).gt("expires_at", new Date().toISOString()).order("chunk_index");
  const count = Math.ceil(Number(row.size_bytes) / SENSITIVE_DOCUMENT_CHUNK_BYTES);
  if (result.error || result.data?.length !== count || count > 10) throw new Error("sensitive-document-incomplete");
  const parts = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const part = result.data[index];
      if (part.chunk_index !== index) throw new Error("sensitive-document-incomplete");
      const bytes = decryptSensitive(part.envelope, chunkContext(row,index), ring);
      parts.push(bytes);
      if (bytes.length !== Math.min(SENSITIVE_DOCUMENT_CHUNK_BYTES, row.size_bytes - index * SENSITIVE_DOCUMENT_CHUNK_BYTES)) throw new Error("sensitive-document-incomplete");
    }
    return Buffer.concat(parts);
  } finally { for (const part of parts) part.fill(0); }
}
