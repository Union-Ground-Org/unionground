// @vitest-environment node
// Coverage for api/form-filing.js: the refusal and failure answers that come
// before any filing work, plus the query defaults and the redacted
// generation-failure log. Union Ground has no member PIN, so no PIN
// session restriction or step-up stands between a session and its filing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfControl = vi.hoisted(() => ({ failWith: undefined, fail: false }));

// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));
vi.mock("../src/lib/formFilingPdf.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderFormFilingPdf: (...args) => {
      if (pdfControl.fail) throw pdfControl.failWith;
      return actual.renderFormFilingPdf(...args);
    },
  };
});

const { default: handler } = await import("../api/form-filing.js");

const SUPABASE = "https://project.supabase.co";
const FORM_ID = "f2010001-1111-4111-8111-111111111111";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function jwtLike(amr) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [part({ alg: "ES256" }), part({ sub: USER_ID, amr }), "x".repeat(12)].join(".");
}
const PIN_TOKEN = jwtLike([{ method: "otp", timestamp: 1 }]);

const payload = {
  form: { id: FORM_ID, template_key: "service_request", template_version: 1, status: "approved", answers: { category: "other", description: "Proof" } },
  template: { label_en: "Service request", label_es: "Solicitud", field_schema: { steps: [{ title: { en: "Request", es: "Solicitud" }, fields: [{ key: "description", label: { en: "Description", es: "Descripción" } }] }] } },
  filer: { id: USER_ID, name: "Member" },
  filerSignature: { signedAt: "2026-08-12T12:00:00Z", signatureDigest: "sig", strokes: [[{ x: 10, y: 10 }, { x: 900, y: 900 }]] },
  cosigners: [], attachments: [],
  approval: { approvedBy: "s1", approvedAt: "2026-08-12T13:00:00Z", reviewerName: "Steward", note: null, artifactDigest: "artifact" },
};

function reply(body, status = 200) {
  const text = body === null ? "" : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

function request(overrides = {}) {
  return { method: "GET", headers: { authorization: "Bearer member-token" }, query: { formId: FORM_ID, lang: "en" }, ...overrides };
}

function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; },
    end(body) { out.body = body; },
  };
}

async function run(req = request()) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

function parsed(out) {
  return typeof out.body === "string" ? JSON.parse(out.body) : out.body;
}

function stubFetch(routes) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    calls.push(String(url));
    for (const [needle, answer] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer() : answer;
      }
    }
    throw new Error(`unexpected fetch ${url} ${init.method || "GET"}`);
  }));
  return calls;
}

beforeEach(() => {
  pdfControl.fail = false;
  pdfControl.failWith = undefined;
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("api/form-filing.js step-up and failure answers", () => {
  it("treats a request with no query object as a missing form", async () => {
    const calls = stubFetch({});
    const out = await run(request({ query: undefined }));
    expect(out.status).toBe(400);
    expect(parsed(out).error).toBe("A valid form and language are required.");
    expect(calls).toHaveLength(0);
  });

  it("defaults the language to English when only the form is named", async () => {
    stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      can_access_form_filing: reply(true),
      get_form_filing_payload: reply(payload),
    });
    const out = await run(request({ query: { formId: FORM_ID } }));
    expect(out.status).toBe(200);
    expect(out.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(out.body.toString("latin1")).toMatch(/^%PDF-1\.4/);
  });

  it("answers 401 when the identity check itself throws", async () => {
    stubFetch({ "/auth/v1/user": new TypeError("offline") });
    const out = await run();
    expect(out.status).toBe(401);
    expect(parsed(out).error).toBe("Your session expired. Sign in again.");
  });

  it("never asks for a PIN step-up, even when a restriction record says restricted", async () => {
    const calls = stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      get_my_session_restriction: reply({ restricted: true, pinSession: true }),
      can_access_form_filing: reply(true),
      get_form_filing_payload: reply(payload),
    });
    const out = await run(request({ headers: { authorization: `Bearer ${PIN_TOKEN}` } }));
    expect(out.status).toBe(200);
    expect(out.body.toString("latin1")).toMatch(/^%PDF-1\.4/);
    expect(String(out.body)).not.toContain("step-up-required");
    expect(calls.some((url) => url.includes("get_my_session_restriction"))).toBe(false);
    expect(calls.some((url) => url.includes("can_access_form_filing"))).toBe(true);
  });

  it("does not depend on a session restriction check that is unavailable", async () => {
    const calls = stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      get_my_session_restriction: reply({ message: "down" }, 500),
      can_access_form_filing: reply(true),
      get_form_filing_payload: reply(payload),
    });
    const out = await run(request({ headers: { authorization: `Bearer ${PIN_TOKEN}` } }));
    expect(out.status).toBe(200);
    expect(calls.some((url) => url.includes("get_my_session_restriction"))).toBe(false);
  });

  it("serves an unrestricted PIN-token session once the database says it is full", async () => {
    stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      get_my_session_restriction: reply({ restricted: false, pinSession: true }),
      can_access_form_filing: reply(true),
      get_form_filing_payload: reply(payload),
    });
    const out = await run(request({ headers: { authorization: `Bearer ${PIN_TOKEN}` } }));
    expect(out.status).toBe(200);
  });

  it("collapses a thrown authorization call to 404", async () => {
    stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      can_access_form_filing: new TypeError("offline"),
    });
    const out = await run();
    expect(out.status).toBe(404);
    expect(parsed(out).error).toBe("Filing copy unavailable.");
  });

  it("logs a bare name and message-less failure as nulls and still answers 503", async () => {
    stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      can_access_form_filing: reply(true),
      get_form_filing_payload: reply(payload),
    });
    pdfControl.fail = true;
    pdfControl.failWith = undefined;
    const out = await run();
    expect(out.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith("[form-filing] generation failed", { name: null, message: null });
    expect(String(out.body)).not.toContain("Member");
  });

  it("logs only the error name and message of a generation failure", async () => {
    stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      can_access_form_filing: reply(true),
      get_form_filing_payload: reply(payload),
    });
    pdfControl.fail = true;
    pdfControl.failWith = new RangeError("pdf-too-large");
    const out = await run();
    expect(out.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith("[form-filing] generation failed", { name: "RangeError", message: "pdf-too-large" });
  });

  it("rejects a payload that lacks the approval digest", async () => {
    stubFetch({
      "/auth/v1/user": reply({ id: USER_ID }),
      can_access_form_filing: reply(true),
      get_form_filing_payload: reply({ ...payload, approval: {} }),
    });
    const out = await run();
    expect(out.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith("[form-filing] generation failed", { name: "Error", message: "malformed-filing-payload" });
  });
});
