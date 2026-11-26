import { createHash } from "node:crypto";
import { supabaseHeaders } from "./http.js";
import { PRIVATE_FILE_MAX_BYTES } from "./privateFileSafety.js";

// union-document-contributions (REQ-UNIONGROUND-UNION-DOCUMENT-INTAKE-PAGE-
// 20261022) is the public /contribute bucket; its targets come only from the
// service-only authorize_union_document_file_inspection lease.
const BUCKETS = new Set(["case-files", "chapter-task-files", "member-form-files", "organization-knowledge", "union-document-contributions"]);
function failure(reason) { return new Error(`private-file-storage-${reason}`); }

function storageUrl(backend, target) {
  let origin;
  try { origin = new URL(backend.url); } catch { throw failure("target"); }
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || typeof backend.serviceRoleKey !== "string" || !backend.serviceRoleKey
    || !BUCKETS.has(target?.bucketId) || typeof target.objectName !== "string"
    || !target.objectName || target.objectName.length > 1024 || target.objectName.includes("\\")
    || [...target.objectName].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || target.objectName.split("/").some((part) => !part || part === "." || part === "..")
    || !Number.isSafeInteger(target.sizeBytes) || target.sizeBytes < 1 || target.sizeBytes > PRIVATE_FILE_MAX_BYTES
    || (target.sha256 != null && !/^[0-9a-f]{64}$/.test(target.sha256))) throw failure("target");
  const path = target.objectName.split("/").map(encodeURIComponent).join("/");
  return `${origin.origin}/storage/v1/object/authenticated/${target.bucketId}/${path}`;
}

/** The caller must derive `target` from the user's authorized file RPC, never
 * from a request URL/path. The privileged download is bounded while reading,
 * not after buffering an arbitrarily large response. Raw errors stay private. */
export async function downloadPrivateObjectBytes(backend, target, { signal, fetch: fetcher = globalThis.fetch } = {}) {
  const url = storageUrl(backend, target);
  if (!signal || signal.aborted) throw failure("budget");
  let response;
  try {
    response = await fetcher(url, {
      method: "GET", redirect: "error", signal,
      headers: supabaseHeaders(backend.serviceRoleKey),
    });
  } catch { throw failure("unavailable"); }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw failure("unavailable");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[1-9][0-9]*$/.test(declared) || Number(declared) !== target.sizeBytes)) {
    await response.body.cancel().catch(() => {});
    throw failure("size");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const parts = [];
  let size = 0;
  try {
    if (signal.aborted) throw failure("budget");
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw failure("budget");
      if (done) break;
      size += value.byteLength;
      if (size > target.sizeBytes) throw failure("size");
      parts.push(Buffer.from(value));
    }
    if (size !== target.sizeBytes) throw failure("size");
    const bytes = Buffer.concat(parts, size);
    if (target.sha256 && createHash("sha256").update(bytes).digest("hex") !== target.sha256) throw failure("digest");
    return bytes;
  } catch (error) {
    // Only fixed local error codes may leave the storage boundary.
    if (/^private-file-storage-(size|digest|budget)$/.test(error?.message)) throw error;
    throw failure("unavailable");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
