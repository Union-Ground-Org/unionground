// @vitest-environment node
// #8725 (G7-8723 P3-e): a filing font that cannot be read never fails the
// download; the copy is built with [U+XXXX] codes and the copy's note.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

vi.mock("../api/_lib/filingFont.js", () => ({
  filingFont: () => { throw new Error("ENOENT: font file missing"); },
}));

const { default: handler } = await import("../api/form-filing.js");

const FORM_ID = "f2010001-1111-4111-8111-111111111111";
const payload = {
  form: { id: FORM_ID, template_key: "service_request", template_version: 1, status: "approved", answers: { description: "Overtime at the Łódź warehouse" } },
  template: { label_en: "Service request", field_schema: { steps: [{ title: { en: "Request" }, fields: [{ key: "description", label: { en: "Description" } }] }] } },
  filer: { id: "u1", name: "Łukasz Kowalski" },
  filerSignature: { signedAt: "2026-11-14T12:00:00Z", signatureDigest: "sig", strokes: { kind: "typed", name: "Łukasz Kowalski" } },
  cosigners: [], attachments: [],
  approval: { approvedBy: "s1", approvedAt: "2026-11-14T13:00:00Z", reviewerName: "Steward", note: null, artifactDigest: "artifact" },
};

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return { ok: true, json: async () => ({ id: "u1" }) };
    if (target.includes("/rpc/can_access_form_filing")) return { ok: true, status: 200, text: async () => "true" };
    if (target.includes("/rpc/get_form_filing_payload")) return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    throw new Error(`unexpected fetch ${target}`);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("filing copy without a readable font file", () => {
  it("still returns the copy, with codes and the note instead of a 503", async () => {
    const out = { status: 0, headers: {}, body: null };
    const response = {
      status(code) { out.status = code; return this; },
      setHeader(name, value) { out.headers[name] = value; },
      end(body) { out.body = body; },
    };
    await handler({ method: "GET", headers: { authorization: "Bearer member-token" }, query: { formId: FORM_ID, lang: "en" } }, response);
    expect(out.status).toBe(200);
    expect(out.headers["Content-Type"]).toBe("application/pdf");
    const pdf = out.body.toString("latin1");
    expect(pdf).toContain("(Description: Overtime at the [U+0141]ód[U+017A] warehouse) Tj");
    expect(pdf).toContain("([U+0141]ukasz Kowalski) Tj");
    expect(pdf).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
    expect(pdf).not.toContain("/F3");
    expect(console.error).toHaveBeenCalledWith("[form-filing] filing font unavailable", { error: "Error: ENOENT: font file missing" });
  });
});
