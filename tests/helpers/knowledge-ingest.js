import { vi } from "vitest";
import handler from "../../api/knowledge-ingest.js";
import { PORTAL_HOST } from "./fictional-provider.js";

export const FILE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from("A verified policy body.");

export function installIngestBackend(targetOverrides = {}, conversionFailure = null) {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const name = String(url).split("/rpc/")[1];
    calls.push({ name, url: String(url), body: options.body && JSON.parse(options.body) });
    let payload;
    if (name === "authorize_knowledge_ingest") payload = {
      organizationId: "organization-1", actorUserId: "actor-1", fileId: FILE_ID,
      bucketId: "knowledge", objectName: "organization-1/source.txt",
      fileName: "source.txt", mimeType: "text/plain", byteSize: bytes.length,
      contentSha256: null, category: "policy", ...targetOverrides,
    };
    else if (name === "authorize_private_upload_inspection") payload = { fileId: FILE_ID, current: true };
    else if (name === "record_knowledge_conversion" && conversionFailure) return conversionFailure;
    else if (name === "record_knowledge_conversion") payload = { id: "conversion-1" };
    else if (name === "replace_knowledge_source_chunks") payload = { id: SOURCE_ID };
    else if (String(url).includes("/storage/")) return {
      ok: true, status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  }));
  return calls;
}

export async function ingest() {
  const response = { statusCode: 0, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await handler({ method: "POST", headers: { authorization: "Bearer member-token", host: PORTAL_HOST },
    body: { sourceId: SOURCE_ID } }, response);
  return response;
}

export function resetIngestBackend() {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
