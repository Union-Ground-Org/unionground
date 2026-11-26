import { createClient } from "@supabase/supabase-js";
import { sensitiveSupabaseFetch } from "./sensitiveSupabase.js";

// Only this transport sees the original HTTP response, before SDK normalization.
// https://supabase.com/docs/guides/storage/debugging/error-codes
async function storageFailure(response) {
  if (![400, 403, 404].includes(response.status)
    || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return "unavailable";
  const reader = response.body?.getReader();
  if (!reader) return "unavailable";
  try {
    const parts = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return "unavailable";
      parts.push(value);
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
    if (!body || Array.isArray(body) || typeof body !== "object") return "unavailable";
    // Hosted Supabase's object endpoint wraps typed NoSuchKey in HTTP 400.
    // Require the complete observed tuple; generic 400s and legacy bodies
    // without a typed code remain unavailable. All body statuses must agree
    // on semantic 404, including optional discriminators.
    const hostedAbsence = response.status === 400 && body.code === "NoSuchKey"
      && body.error === "not_found" && [404, "404"].includes(body.statusCode);
    const semanticStatus = hostedAbsence ? 404 : response.status;
    if (["status", "statusCode", "httpStatusCode"].some((key) => Object.hasOwn(body, key)
      && body[key] !== semanticStatus && body[key] !== String(semanticStatus))) return "unavailable";
    if ((response.status === 404 || hostedAbsence) && body.code === "NoSuchKey" && body.message === "Object not found"
      && (!Object.hasOwn(body, "error") || ["NoSuchKey", "not_found"].includes(body.error))) return "absent";
    if (response.status === 403 && body.code === "AccessDenied" && typeof body.message === "string" && body.message.length > 0
      && (!Object.hasOwn(body, "error") || ["AccessDenied", "Unauthorized"].includes(body.error))) return "denied";
    return "unavailable";
  } catch { return "unavailable"; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Ciphertext buckets only: case files and sealed FMLA form attachments (#5747).
const SENSITIVE_BUCKETS = new Set(["case-files", "member-form-files"]);
export function createSensitiveStorage(origin, key, { token = key, fetch: fetcher = globalThis.fetch, bucket = "case-files" } = {}) {
  if (!SENSITIVE_BUCKETS.has(bucket)) throw new Error("sensitive-storage-bucket-refused");
  const transport = sensitiveSupabaseFetch(key, token, fetcher);
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport } };
  const storage = createClient(origin, key, options).storage.from(bucket);
  return {
    upload: (...args) => storage.upload(...args),
    remove: (...args) => storage.remove(...args),
    async download(name) {
      // Request-local provenance: concurrent/retried requests cannot share a
      // previous absence verdict. No SDK error field is used for a decision.
      let failure = "unavailable";
      const signal = AbortSignal.timeout(10000);
      const scoped = createClient(origin, key, { ...options, global: { ...options.global, fetch: async (url, init) => {
        const response = await transport(url, { ...init, signal, redirect: "error", cache: "no-store" });
        if (response.status !== 200) {
          try { failure = await storageFailure(response); }
          finally { await response.body?.cancel().catch(() => {}); }
          throw new Error("sensitive-storage-unavailable");
        }
        return response;
      } } }).storage.from(bucket);
      try {
        const result = await scoped.download(name);
        if (signal.aborted || result.error || !result.data?.size) return { data: null, error: "sensitive-storage-unavailable", failure: signal.aborted ? "unavailable" : failure };
        return { data: result.data, error: null };
      } catch { return { data: null, error: "sensitive-storage-unavailable", failure: signal.aborted ? "unavailable" : failure }; }
    },
  };
}
