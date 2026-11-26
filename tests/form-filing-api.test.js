// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/form-filing.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const URL = "https://project.supabase.co";
const FORM_ID = "f2010001-1111-4111-8111-111111111111";

const payload = {
  form: { id: FORM_ID, template_key: "service_request", template_version: 1, status: "approved", answers: { category: "other", description: "Proof" } },
  template: { label_en: "Service request", label_es: "Solicitud", field_schema: { steps: [{ title: { en: "Request", es: "Solicitud" }, fields: [{ key: "description", label: { en: "Description", es: "Descripción" } }] }] } },
  filer: { id: "u1", name: "Member" },
  filerSignature: { signedAt: "2026-08-12T12:00:00Z", signatureDigest: "sig", strokes: [[{ x: 10, y: 10 }, { x: 900, y: 900 }]] },
  cosigners: [], attachments: [],
  approval: { approvedBy: "s1", approvedAt: "2026-08-12T13:00:00Z", reviewerName: "Steward", note: null, artifactDigest: "artifact" },
};

function request(overrides = {}) {
  return {
    method: "GET",
    headers: { authorization: "Bearer member-token" },
    query: { formId: FORM_ID, lang: "en" },
    ...overrides,
  };
}

function response() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = body; },
  };
}

function installFetch({ user = { id: "u1" }, allowed = true, filingPayload = payload, rpcStatus = 200 } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/v1/user")) {
      return user ? { ok: true, json: async () => user } : { ok: false };
    }
    if (String(url).includes("/rpc/can_access_form_filing")) {
      return { ok: rpcStatus === 200, status: rpcStatus, text: async () => JSON.stringify(allowed) };
    }
    if (String(url).includes("/rpc/get_form_filing_payload")) {
      return { ok: rpcStatus === 200, status: rpcStatus, text: async () => JSON.stringify(filingPayload) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}

async function run(req = request()) {
  const res = response();
  await handler(req, res);
  return res.out;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", URL);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/form-filing", () => {
  it("rejects methods, malformed ids/languages and missing bearer before provider calls", async () => {
    const calls = installFetch();
    expect((await run(request({ method: "POST" }))).status).toBe(405);
    expect((await run(request({ headers: {} }))).status).toBe(401);
    expect((await run(request({ query: { formId: "bad", lang: "en" } }))).status).toBe(400);
    expect((await run(request({ query: { formId: FORM_ID, lang: "fr" } }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 503 without all server configuration", async () => {
    installFetch();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect((await run()).status).toBe(503);
  });

  it("returns 401 for an expired member token", async () => {
    installFetch({ user: null });
    expect((await run()).status).toBe(401);
  });

  it("collapses unavailable and provider authorization failures to 404", async () => {
    installFetch({ allowed: false });
    expect((await run()).status).toBe(404);
    vi.unstubAllGlobals();
    installFetch({ rpcStatus: 403 });
    expect((await run()).status).toBe(404);
  });

  it("authorizes with the member token, fetches payload with service role, and returns private PDF bytes", async () => {
    const calls = installFetch();
    const out = await run();
    expect(out.status).toBe(200);
    expect(out.headers["Content-Type"]).toBe("application/pdf");
    expect(out.headers["Cache-Control"]).toBe("no-store, private");
    expect(out.headers["Content-Disposition"]).toBe(`attachment; filename="union-base-filing-${FORM_ID}.pdf"`);
    expect(Buffer.isBuffer(out.body)).toBe(true);
    expect(out.body.toString("latin1")).toMatch(/^%PDF-1\.4/);

    const authz = calls.find((call) => call.url.includes("can_access_form_filing"));
    const filing = calls.find((call) => call.url.includes("get_form_filing_payload"));
    expect(authz.init.headers.Authorization).toBe("Bearer member-token");
    expect(JSON.parse(authz.init.body)).toEqual({ p_form_id: FORM_ID });
    expect(filing.init.headers.Authorization).toBe("Bearer service-key");
    expect(filing.init.headers.apikey).toBe("service-key");
    expect(JSON.parse(filing.init.body)).toEqual({ p_form_id: FORM_ID, p_user_id: "u1" });
  });

  it.each([
    ["Spanish", "es", "Copia oficial de presentación de Union Ground", "Solicitud", "Descripción"],
    ["English", "en", "Union Ground official filing copy", "Service request", "Description"],
    ["default English", undefined, "Union Ground official filing copy", "Service request", "Description"],
  ])("renders a successful %s filing download through the real renderer", async (_name, lang, heading, templateLabel, fieldLabel) => {
    const calls = installFetch();
    const query = { formId: FORM_ID };
    if (lang !== undefined) query.lang = lang;

    const out = await run(request({ query }));

    expect(out.status).toBe(200);
    expect(out.headers["Content-Type"]).toBe("application/pdf");
    expect(Buffer.isBuffer(out.body)).toBe(true);
    const pdf = new TextDecoder("windows-1252").decode(out.body);
    expect(pdf).toMatch(/^%PDF-1\.4/);
    expect(pdf).toContain(heading);
    expect(pdf).toContain(templateLabel);
    expect(pdf).toContain(`${fieldLabel}: Proof`);
    expect(calls.filter((call) => call.url.includes("get_form_filing_payload"))).toHaveLength(1);
  });

  it("prints a typed signature name outside WinAnsi exactly, in the embedded Unicode font (#8701)", async () => {
    const typed = structuredClone(payload);
    typed.filerSignature.strokes = { kind: "typed", name: "\u0141ukasz Kowalski" };
    installFetch({ filingPayload: typed });
    const out = await run();
    expect(out.status).toBe(200);
    const pdf = out.body.toString("latin1");
    expect(pdf).toContain("/Subtype /CIDFontType2 /BaseFont /NotoSans-Regular");
    expect(pdf).toContain("/Filter /FlateDecode");
    expect(pdf).toMatch(/BT \/F3 13 Tf [\d.]+ [\d.]+ Td <[0-9A-F]+> Tj ET/);
    expect(pdf).toMatch(/<[0-9A-F]{4}> <0141>/);
    expect(pdf).not.toContain("?ukasz");
  });

  it("prints a member's name and an answer outside WinAnsi without any \"?\" through the real handler (#8716)", async () => {
    const copy = structuredClone(payload);
    copy.form.answers.description = "Overtime at the \u0141\u00f3d\u017a warehouse";
    copy.filer.name = "\u0141ukasz Kowalski";
    installFetch({ filingPayload: copy });
    const out = await run();
    expect(out.status).toBe(200);
    const pdf = out.body.toString("latin1");
    expect(pdf).toContain("/Subtype /CIDFontType2 /BaseFont /NotoSans-Regular");
    expect(pdf).toMatch(/<[0-9A-F]{4}> <0141>/);
    expect(pdf).toMatch(/<[0-9A-F]{4}> <017A>/);
    expect(pdf).not.toMatch(/\?ukasz|\?\u00f3d|\[U\+/);
  });

  it("redacts malformed filing-payload errors", async () => {
    const calls = installFetch({ filingPayload: null });
    const out = await run(request({ query: { formId: FORM_ID, lang: "es" } }));
    expect(out.status).toBe(503);
    expect(String(out.body)).not.toContain("Member");
    expect(calls.filter((call) => call.url.includes("get_form_filing_payload"))).toHaveLength(1);
  });
});
