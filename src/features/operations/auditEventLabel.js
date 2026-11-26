// BUG-UG-LEDGER-SAYS-KNOWLEDGE-FILE-UPLOADED-BEFORE-ANY-BYTES-ARRIVE-20261112
// (#8545): prepare_steward_library_upload writes knowledge_file_uploaded with
// reviewStatus pending_scan when it hands out a storage handle, before any
// bytes arrive or the scanner runs, and no later ledger row records the bytes
// or the scan. The ledger names that row an upload started, never an upload.
export const PREPARED_KNOWLEDGE_UPLOAD_LABEL = "operations.audit.event.knowledgeFileUploadStarted";

export function isPreparedKnowledgeUpload(event) {
  return event?.eventType === "knowledge_file_uploaded" && event?.metadata?.reviewStatus === "pending_scan";
}
