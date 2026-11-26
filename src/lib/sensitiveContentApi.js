import { isTrustedPortalOrigin } from "./trustedBackends.js";

// Same-origin (web) calls pass no origin; a native caller names its portal,
// which must be a source-approved pair.
export function sensitiveApiEndpoint(path, origin = "") {
  if (origin && !isTrustedPortalOrigin(origin)) throw new Error("sensitive-data-origin-refused");
  return `${origin}${path}`;
}
// Transport only. Cryptographic keys and operations stay in the API runtime.
// accessToken pins a request to a session the caller already read; without it
// each request bears whichever session is current when it is sent (#6363 round 3).
export async function sensitiveContentRpc(client, operation, args = {}, origin = "", accessToken = null) {
  try {
    const token = accessToken || (await client.auth.getSession()).data?.session?.access_token;
    if (!token) throw new Error("not-authorized");
    const response = await fetch(sensitiveApiEndpoint("/api/sensitive-content", origin), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, args }), cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || !Object.hasOwn(result, "data")) throw new Error("sensitive-data-unavailable");
    return { data: result.data, error: null };
  } catch {
    return { data: null, error: { code: "SENSITIVE_DATA_UNAVAILABLE", message: "Sensitive content is unavailable. Contact your administrator." } };
  }
}

export const SENSITIVE_CASE_MAX_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
export async function uploadSensitiveCaseFile(client, fileId, file, origin = "") {
  return uploadSensitiveDocument("/api/sensitive-case-files", client, fileId, file, origin);
}
// Sealed FMLA form attachments (#5747) use the same transport and limits.
export async function uploadSensitiveFormFile(client, fileId, file, origin = "") {
  return uploadSensitiveDocument("/api/sensitive-form-files", client, fileId, file, origin);
}
// BUG-UG-FORM-FILE-WITH-UNFINISHED-SAFETY-CHECK-CANNOT-BE-REMOVED-20261112
// (#8569): the server removes a form attachment, so an unconfirmed one (its
// safety check never finished) can be removed too. Resolves finalize's receipt.
export async function removeSensitiveFormFile(client, fileId, origin = "") {
  const token = (await client.auth.getSession()).data?.session?.access_token;
  if (!token) throw new Error("not-authorized");
  const response = await fetch(sensitiveApiEndpoint("/api/sensitive-form-files", origin), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "remove", fileId }), cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  // The one server word the member may act on: a restricted session must step
  // up first, and the app opens that prompt for exactly this token.
  if (!response.ok || result.fileId !== fileId || result.status !== "removed"
    || result.receipt?.id !== fileId || result.receipt?.deleted !== true) {
    throw new Error(response.status === 403 ? "not-authorized" : "form-file-removal-unavailable");
  }
  return result.receipt;
}
async function uploadSensitiveDocument(path, client, fileId, file, origin) {
  if (file.size < 1 || file.size > SENSITIVE_CASE_MAX_BYTES) throw new Error("Issue files must be 10 MiB or smaller.");
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length !== file.size) throw new Error("sensitive-document-size-changed");
  const session = await client.auth.getSession();
  const token = session.data?.session?.access_token;
  if (!token) throw new Error("not-authorized");
  async function send(body, status) {
    const response = await fetch(sensitiveApiEndpoint(path, origin), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, fileId }),
    });
    const result = await response.json();
    if (!response.ok || result.fileId !== fileId || result.status !== status
      || (status === "chunk" && result.index !== body.index)) throw new Error("sensitive-document-upload-unavailable");
  }
  try {
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      let binary = "";
      // Bounded batches avoid millions of JS string concatenations on phones.
      for (let part = offset; part < Math.min(data.length, offset + CHUNK_BYTES); part += 32768) {
        binary += String.fromCharCode(...data.subarray(part, Math.min(part + 32768, offset + CHUNK_BYTES)));
      }
      const single = data.length <= CHUNK_BYTES;
      await send({ action: single ? "upload" : "chunk", bytes: btoa(binary), ...(single ? {} : { index: offset / CHUNK_BYTES }) }, single ? "uploaded" : "chunk");
    }
    if (data.length > CHUNK_BYTES) await send({ action: "finish" }, "uploaded");
    return { error: null };
  } finally { data.fill(0); }
}
async function sensitiveCaseRead(client, fileId, origin, fetcher, path = "/api/sensitive-case-files") {
  const session = await client.auth.getSession();
  const token = session.data?.session?.access_token;
  if (!token) throw new Error("not-authorized");
  const parts = [];
  let total, contentType, version, offset;
  while (offset === undefined || offset < total) {
    const response = await fetcher(sensitiveApiEndpoint(path, origin), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "read", fileId, ...(offset === undefined ? {} : { offset }) }), cache: "no-store",
    });
    if (!response.ok) {
      let staleVerdict = false;
      if (response.status === 409 && response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json") {
        try { staleVerdict = (await response.json())?.error === "file-recheck-required"; } catch { /* Malformed responses are unavailable. */ }
      }
      throw Object.assign(new Error("sensitive-document-read-unavailable"), { staleVerdict });
    }
    const size = Number(response.headers.get("X-Sensitive-Total-Bytes"));
    if (!Number.isInteger(size) || size < 1 || size > SENSITIVE_CASE_MAX_BYTES || (total !== undefined && size !== total)) throw new Error("sensitive-document-size-changed");
    const currentVersion = response.headers.get("X-Sensitive-Data-Version");
    if (!currentVersion || (version && currentVersion !== version)) throw new Error("sensitive-document-version-changed");
    version = currentVersion;
    total = size;
    contentType = response.headers.get("Content-Type");
    const part = await response.arrayBuffer();
    if (offset === undefined && part.byteLength === total) { parts.push(part); break; }
    const window = offset ?? 0;
    if (part.byteLength !== Math.min(CHUNK_BYTES, total - window)) throw new Error("sensitive-document-incomplete");
    parts.push(part);
    offset = window + CHUNK_BYTES;
  }
  return { parts, contentType, total };
}
export async function downloadSensitiveCaseFile(client, fileId, origin = "") {
  const result = await sensitiveCaseRead(client, fileId, origin, globalThis.fetch);
  return new Blob(result.parts, { type: result.contentType });
}
export async function downloadSensitiveFormFile(client, fileId, origin = "") {
  const result = await sensitiveCaseRead(client, fileId, origin, globalThis.fetch, "/api/sensitive-form-files");
  return new Blob(result.parts, { type: result.contentType });
}
export async function downloadSensitiveCaseBytes(client, fileId, origin = "", fetcher = globalThis.fetch, path = "/api/sensitive-case-files") {
  const result = await sensitiveCaseRead(client, fileId, origin, fetcher, path);
  const bytes = new Uint8Array(result.total);
  let offset = 0;
  for (const part of result.parts) { bytes.set(new Uint8Array(part), offset); offset += part.byteLength; }
  return bytes.buffer;
}
// A sealed FMLA form attachment's bytes, for the phone, which writes them to
// its protected cache instead of a Blob (#8699).
export async function downloadSensitiveFormBytes(client, fileId, origin = "", fetcher = globalThis.fetch) {
  return downloadSensitiveCaseBytes(client, fileId, origin, fetcher, "/api/sensitive-form-files");
}
