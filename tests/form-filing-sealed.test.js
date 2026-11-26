// @vitest-environment node
// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022 (#5747): a sealed
// FMLA filing is opened in memory for the one no-store PDF response.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));
import handler from "../api/form-filing.js";
import { encryptSensitive, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";

const URL = "https://project.supabase.co";
const FORM_ID = "f2010001-1111-4111-8111-111111111111";
const ORG = "0a000000-0000-4000-8000-000000000001";
const template = { label_en: "FMLA", label_es: "FMLA", field_schema: { steps: [{ title: { en: "Leave", es: "Permiso" },
  fields: [{ key: "reason", label: { en: "Reason", es: "Motivo" }, type: "textarea" }] }] } };
const marker = { sealed: true, filled: ["reason"], dataVersion: "00000000-0000-4000-8000-000000000000" };
const payload = {
  form: { id: FORM_ID, template_key: "fmla_self", template_version: 1, status: "approved", answers: marker },
  template, filer: { id: "u1", name: "Member" },
  filerSignature: { signedAt: "2026-08-12T12:00:00Z", signatureDigest: "sig", strokes: [[{ x: 10, y: 10 }, { x: 900, y: 900 }]] },
  cosigners: [], attachments: [],
  approval: { approvedBy: "s1", approvedAt: "2026-08-12T13:00:00Z", reviewerName: "Steward", note: null, artifactDigest: "artifact" },
};

function installFetch(row, rowStatus = row ? 200 : 406) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/v1/user")) return { ok: true, json: async () => ({ id: "u1" }) };
    if (String(url).includes("/rpc/can_access_form_filing")) return { ok: true, status: 200, text: async () => "true" };
    if (String(url).includes("/rpc/get_form_filing_payload")) return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    if (String(url).includes("/rest/v1/member_forms")) {
      return new Response(JSON.stringify(row), { status: rowStatus, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}
async function run() {
  const out = { status: 0, headers: {}, body: null };
  await handler({ method: "GET", headers: { authorization: "Bearer member-token" }, query: { formId: FORM_ID, lang: "en" } }, {
    status(code) { out.status = code; return this; }, setHeader(name, value) { out.headers[name] = value; }, end(body) { out.body = body; },
  });
  return out;
}
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", URL);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("SENSITIVE_DATA_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
  vi.stubEnv("SENSITIVE_DATA_ACTIVE_KEY", "v1");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("renders the decrypted answers of a sealed filing and keeps the response no-store", async () => {
  const envelope = encryptSensitive(Buffer.from(JSON.stringify({ reason: "Sealed leave reason" })),
    { organization: ORG, record: FORM_ID, field: "answers", purpose: "member_forms" }, sensitiveKeyring());
  const calls = installFetch({ id: FORM_ID, template_key: "fmla_self", organization_id: ORG, answers: marker, encrypted_content: { answers: envelope } });
  const out = await run();
  expect(out.status).toBe(200);
  expect(out.headers["Cache-Control"]).toBe("no-store, private");
  expect(new TextDecoder("windows-1252").decode(out.body)).toContain("Reason: Sealed leave reason");
  const read = calls.find((call) => call.url.includes("/rest/v1/member_forms"));
  expect(read.url).toContain(`id=eq.${FORM_ID}`);
});

it("refuses the copy instead of printing the marker when the envelope cannot be opened", async () => {
  installFetch({ id: FORM_ID, template_key: "fmla_self", organization_id: ORG, answers: marker, encrypted_content: {} });
  const out = await run();
  expect(out.status).toBe(503);
  expect(String(out.body)).not.toContain("dataVersion");
});

it("refuses a filing when the sealed row lookup fails, without printing the marker", async () => {
  installFetch({ message: "Row not visible", code: "PGRST116" }, 406);
  const out = await run();
  expect(out.status).toBe(503);
  expect(out.headers["Content-Type"]).not.toBe("application/pdf");
  expect(String(out.body)).not.toMatch(/dataVersion|filled|Sealed leave reason/);
});

// #6329 (#6289 round 2 P2): only a sealed template's marker routes the filing
// through decryption; an ordinary template's checkbox named "sealed" prints as
// a plain answer.
it("prints an ordinary template's field named sealed without reading the sealed row", async () => {
  const saved = { form: payload.form, template: payload.template };
  payload.form = { ...payload.form, template_key: "grievance", answers: { sealed: true, summary: "Plain grievance text" } };
  payload.template = { ...template, field_schema: { steps: [{ title: { en: "Facts", es: "Hechos" },
    fields: [{ key: "summary", label: { en: "Summary", es: "Resumen" }, type: "text" }] }] } };
  try {
    const calls = installFetch(null);
    const out = await run();
    expect(out.status).toBe(200);
    expect(new TextDecoder("windows-1252").decode(out.body)).toContain("Summary: Plain grievance text");
    expect(calls.some((call) => call.url.includes("/rest/v1/member_forms"))).toBe(false);
  } finally {
    Object.assign(payload, saved);
  }
});
