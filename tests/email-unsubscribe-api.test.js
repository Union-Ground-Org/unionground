// @vitest-environment node
// SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001: the RFC 8058
// one-click route. A GET only confirms (link scanners must not unsubscribe
// anyone); a POST hands the token to the service-role RPC that verifies the
// database signature, and every refusal looks the same.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/email-unsubscribe.js";
import { UNSUBSCRIBE_TOKEN, unsubscribeHeaders, unsubscribeUrl } from "../api/_lib/engagementEmail.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
// The shipped SAMPLE backend pins no project; the SAMPLE refusal under test
// must come from the surface, so a fictional pinned project is configured.
vi.mock("../src/lib/sampleBackend.js", async (importOriginal) =>
  (await import("./helpers/batch02-pinned-sample-backend.js")).pinnedSampleBackendModule(await importOriginal()));

const TOKEN = `00000000-0000-4000-8000-0000000000aa.announcements.1790000000.${"A".repeat(43)}`;
const SURVEY_TOKEN = `00000000-0000-4000-8000-0000000000aa.surveys.1790000000.${"b".repeat(43)}`;

function recorder() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; return this; },
    end(body) { out.body = body ?? ""; return this; },
  };
}

function request(method, { token = TOKEN, headers = {}, host = PORTAL_HOST } = {}) {
  return {
    method,
    url: `/api/email-unsubscribe?t=${encodeURIComponent(token)}`,
    query: { t: token },
    headers: { host, ...headers },
    body: method === "POST" ? "List-Unsubscribe=One-Click" : undefined,
  };
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value), json: async () => value };
}

async function run(req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("SAMPLE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "sample-service");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("engagement email one-click unsubscribe route", () => {
  it("builds the header pair and link the delivery job sends", () => {
    const url = unsubscribeUrl(TOKEN);
    expect(url).toBe(`${PORTAL_ORIGIN}/api/email-unsubscribe?t=${TOKEN}`);
    expect(unsubscribeHeaders(url)).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    // No portal origin, no link: an engagement email cannot go out without a
    // working one-click unsubscribe.
    expect(() => unsubscribeUrl(TOKEN, "")).toThrow(/No Union Ground portal origin/);
    expect(TOKEN).toMatch(UNSUBSCRIBE_TOKEN);
    expect(TOKEN.replace("announcements", "welcome")).toMatch(UNSUBSCRIBE_TOKEN);
    for (const bad of [`${TOKEN}x`, TOKEN.replace("announcements", "votes"), TOKEN.replace("0000000000aa", "0000000000AA"), "", "a.b.c.d"]) {
      expect(bad).not.toMatch(UNSUBSCRIBE_TOKEN);
    }
  });

  it("answers a GET with a confirmation form and changes nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request("GET"));
    expect(out.status).toBe(200);
    expect(out.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.body).toContain(`<form method="post" action="/api/email-unsubscribe?t=${TOKEN}">`);
    expect(out.body).toContain("union announcement emails");
    expect(out.body).toContain("anuncios del sindicato");
    expect(out.body).toContain('rel="noreferrer"');
    expect(fetchMock).not.toHaveBeenCalled();

    const survey = await run(request("GET", { token: SURVEY_TOKEN }));
    expect(survey.body).toContain("survey emails");
  });

  it("performs the one-click POST a mail provider sends with no Origin or session", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ applied: true, category: "announcements" }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await run(request("POST"));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ unsubscribed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${SUPABASE_ORIGIN}/rest/v1/rpc/apply_engagement_email_unsubscribe`);
    expect(JSON.parse(init.body)).toEqual({ p_token: TOKEN });
    expect(init.headers.Authorization).toBe("Bearer service-role-key");
  });

  it("answers the confirmation form's POST with a page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ applied: true, category: "surveys" })));
    const out = await run(request("POST", { token: SURVEY_TOKEN, headers: { accept: "text/html", origin: PORTAL_ORIGIN } }));
    expect(out.status).toBe(200);
    expect(out.body).toContain("Survey emails are off");
    expect(out.body).toContain("Configuración");
  });

  it("gives one refusal for a forged, expired or unknown token and never calls the database for a malformed one", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ applied: false }));
    vi.stubGlobal("fetch", fetchMock);
    const refused = await run(request("POST"));
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ error: "invalid-unsubscribe-link" });
    const page = await run(request("POST", { headers: { "sec-fetch-mode": "navigate" } }));
    expect(page.status).toBe(400);
    expect(page.body).toContain("not valid or has expired");
    fetchMock.mockClear();
    for (const token of ["", "not-a-token", `${TOKEN}.extra`]) {
      expect((await run(request("POST", { token }))).status).toBe(400);
      expect((await run(request("GET", { token }))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the token from the URL when the runtime supplies no parsed query", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ applied: true, category: "announcements" }));
    vi.stubGlobal("fetch", fetchMock);
    const req = request("POST");
    delete req.query;
    expect((await run(req)).status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ p_token: TOKEN });
    const broken = { ...request("POST"), query: undefined, url: "http://[" };
    expect((await run(broken)).status).toBe(400);
  });

  it("reports an unavailable database or configuration instead of pretending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "down" }, 503)));
    expect((await run(request("POST"))).status).toBe(503);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run(request("POST"))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses other methods and the SAMPLE surface without touching any backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await run(request("PUT"))).status).toBe(405);
    expect((await run(request("DELETE"))).status).toBe(405);
    const sample = await run(request("POST", { host: SAMPLE_HOST }));
    expect(sample.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
