import { createSensitiveServiceClient } from "./sensitiveSupabase.js";
import { decryptSensitive, encryptSensitive, sensitiveKeyring } from "./sensitiveDataCrypto.js";
import { SENSITIVE_DOCUMENT_CHUNK_BYTES, SENSITIVE_DOCUMENT_MAX_BYTES } from "./sensitiveCaseDocuments.js";

// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022 (#5747): a sealed
// FMLA form's attachment uses the case-file protection class with its own
// purpose strings, so a form envelope can never open as a case document.
export function formDocumentContext(row) {
  return { organization: row.organization_id, record: row.id, field: "bytes", purpose: "form-document" };
}
export function encryptFormDocument(bytes, row, ring) {
  if (bytes.length !== Number(row.size_bytes) || bytes.length < 1 || bytes.length > SENSITIVE_DOCUMENT_MAX_BYTES) throw new Error("sensitive-document-size");
  const full = encryptSensitive(bytes, formDocumentContext(row), ring);
  return { ciphertext: Buffer.from(full.payload.ciphertext, "base64"), envelope: { ...full, payload: { nonce: full.payload.nonce, tag: full.payload.tag } } };
}
export function decryptFormDocument(bytes, row, ring) {
  if (bytes.length !== Number(row.size_bytes) || !row.encrypted_content) throw new Error("sensitive-document-unavailable");
  const envelope = { ...row.encrypted_content, payload: { ...row.encrypted_content.payload, ciphertext: bytes.toString("base64") } };
  return decryptSensitive(envelope, formDocumentContext(row), ring);
}
export function formChunkContext(row, index) {
  if (!Number.isInteger(index) || index < 0 || index > 9) throw new Error("sensitive-document-chunk-refused");
  return { organization: row.organization_id, record: row.id, field: "bytes", purpose: `form-document-chunk-${String.fromCharCode(97 + index)}` };
}
export async function assembleFormChunks(service, row, ring) {
  const result = await service.from("sensitive_form_chunks").select("chunk_index,envelope")
    .eq("file_id", row.id).gt("expires_at", new Date().toISOString()).order("chunk_index");
  const count = Math.ceil(Number(row.size_bytes) / SENSITIVE_DOCUMENT_CHUNK_BYTES);
  if (result.error || result.data?.length !== count || count > 10) throw new Error("sensitive-document-incomplete");
  const parts = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const part = result.data[index];
      if (part.chunk_index !== index) throw new Error("sensitive-document-incomplete");
      const bytes = decryptSensitive(part.envelope, formChunkContext(row, index), ring);
      parts.push(bytes);
      if (bytes.length !== Math.min(SENSITIVE_DOCUMENT_CHUNK_BYTES, row.size_bytes - index * SENSITIVE_DOCUMENT_CHUNK_BYTES)) throw new Error("sensitive-document-incomplete");
    }
    return Buffer.concat(parts);
  } finally { for (const part of parts) part.fill(0); }
}

// The inspector learns whether a form attachment is sealed only from this
// service projection, which needs an active attempt on the exact object. A
// plaintext (unsealed) attachment answers null and is inspected as before.
export async function sealedFormInspectionRow(backend, target) {
  const service = createSensitiveServiceClient(backend.url, backend.serviceRoleKey);
  const result = await service.rpc("sensitive_form_inspection_metadata", { p_file_id: target.fileId, p_attempt_id: target.attemptId });
  if (result.error) throw new Error("sensitive-document-unavailable");
  if (!result.data) return null;
  if (result.data.id !== target.fileId || result.data.object_name !== target.objectName) throw new Error("sensitive-document-unavailable");
  return result.data;
}
export function decryptInspectedFormDocument(backend, row, bytes) {
  return decryptFormDocument(bytes, row, sensitiveKeyring(backend.surface));
}
