// REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117 (#9038):
// /api/public-sections names the released public-page sections, and only the
// ones this build knows. A failed read or a missing backend names none.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { PUBLIC_SECTIONS } from "../api/public-sections.js";
import { PUBLIC_SECTIONS as WEB_SECTIONS } from "../src/lib/publicSections.js";
import { PORTAL_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

async function request({ method = "GET", host = PORTAL_HOST } = {}) {
  let body;
  const headers = {};
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { headers[name] = value; return this; },
    end(value) { body = JSON.parse(value); },
  };
  await handler({ method, headers: { host } }, response);
  return { status: response.statusCode, body, headers };
}

const RPC = `${SUPABASE_ORIGIN}/rest/v1/rpc/get_public_section_release_state`;
const answer = (data, status = 200) => vi.fn(async () => new Response(JSON.stringify(data), { status }));

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_live");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "secret-service-key-never-needed");
  vi.stubEnv("VITE_APP_SURFACE", "saas");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("public page section release route", () => {
  it("knows the same four sections as the web pages", () => {
    expect(PUBLIC_SECTIONS).toEqual(["sign_in_design_2", "sign_in_design_3", "sign_in_design_4", "unions_map_3d"]);
    expect(WEB_SECTIONS).toEqual(PUBLIC_SECTIONS);
  });

  it("names the released sections from one publishable-key read, never with a service credential", async () => {
    const fetchMock = answer({ released: ["unions_map_3d", "sign_in_design_2"] });
    vi.stubGlobal("fetch", fetchMock);
    const result = await request();
    expect(result).toMatchObject({ status: 200, body: { released: ["sign_in_design_2", "unions_map_3d"] }, headers: { Vary: "Host" } });
    expect(result.headers["Cache-Control"]).toContain("no-store");
    expect(Object.keys(result.body)).toEqual(["released"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(RPC);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ apikey: "sb_publishable_live" });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret-service-key");
  });

  it("names nothing while every section is held", async () => {
    vi.stubGlobal("fetch", answer({ released: [] }));
    expect(await request()).toMatchObject({ status: 200, body: { released: [] } });
  });

  it("drops a name this build does not know and any value that is not a list", async () => {
    vi.stubGlobal("fetch", answer({ released: ["sign_in_design_9", "unions_map_3d", 7] }));
    expect((await request()).body).toEqual({ released: ["unions_map_3d"] });
    vi.stubGlobal("fetch", answer({ released: "sign_in_design_2" }));
    expect((await request()).body).toEqual({ released: [] });
  });

  it.each([
    ["a refused read", () => answer({ message: "boom" }, 500)],
    ["a missing function", () => answer({ code: "PGRST202" }, 404)],
    ["a network failure", () => vi.fn(async () => { throw new TypeError("fetch failed"); })],
  ])("names nothing after %s", async (_name, make) => {
    vi.stubGlobal("fetch", make());
    expect(await request()).toMatchObject({ status: 503, body: { released: [] } });
  });

  it("bounds the read with a timeout, and names nothing when the database is too slow", async () => {
    const fetchMock = vi.fn((_url, init) => new Promise((_done, fail) => {
      // The read carries an abort signal (8 s, api/_lib/http.js); a slow
      // function is cut off there. Here the signal fires at once.
      expect(init.signal).toBeInstanceOf(AbortSignal);
      fail(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await request()).toMatchObject({ status: 503, body: { released: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names nothing without a backend, and refuses anything but GET", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    const fetchMock = answer({ released: ["sign_in_design_2"] });
    vi.stubGlobal("fetch", fetchMock);
    expect(await request()).toMatchObject({ status: 503, body: { released: [] } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await request({ method: "POST" })).status).toBe(405);
  });
});
