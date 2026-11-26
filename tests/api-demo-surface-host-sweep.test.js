// @vitest-environment node
// BUG-UG-DEMO-SURFACE-PREVIEW-RESOLVES-PRODUCTION-BACKEND-20260908
//
// Every API route that selects its backend through resolveSupabaseBackend is
// driven as a demo-surface build receiving an ordinary request on an unlisted
// .vercel.app preview host. Whatever status each route answers (503, 401, 409,
// 400 ...), none of them may contact the production project or emit a
// production credential. The inventory is derived from the source tree so a
// new caller is covered automatically.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DENIED_PRODUCTION_REF, DENIED_SAMPLE_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";

const PRODUCTION_URL = deniedSupabaseOrigin(DENIED_PRODUCTION_REF);
const SAMPLE_URL = deniedSupabaseOrigin(DENIED_SAMPLE_REF);
const PREVIEW_HOST = "unionground-git-feature-example-team.vercel.app";
const PRODUCTION_MARKERS = [PRODUCTION_URL, "production-public-key", "production-service-key"];

// Anchored to this module, not to the working directory: the sweep below runs
// at collection time, so a cwd-derived path fails the whole file when vitest is
// invoked from a subdirectory with --root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = join(repoRoot, "api");
const callers = [];
for (const entry of readdirSync(apiRoot, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".js") && readFileSync(join(apiRoot, entry.name), "utf8").includes("resolveSupabaseBackend(")) {
    callers.push(entry.name.slice(0, -3));
  }
  if (entry.isDirectory() && entry.name !== "_lib") {
    for (const nested of readdirSync(join(apiRoot, entry.name))) {
      if (nested.endsWith(".js") && readFileSync(join(apiRoot, entry.name, nested), "utf8").includes("resolveSupabaseBackend(")) {
        callers.push(`${entry.name}/${nested.slice(0, -3)}`);
      }
    }
  }
}
callers.sort();

function stubDemoSurfaceEnv() {
  const env = {
    VITE_APP_SURFACE: "demo",
    VITE_SUPABASE_URL: PRODUCTION_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: "production-public-key",
    SUPABASE_SERVICE_ROLE_KEY: "production-service-key",
    SAMPLE_SUPABASE_URL: SAMPLE_URL,
    SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-public-key",
    SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service-key",
    CRON_SECRET: "cron-secret-for-tests",
    // Trust the preview's own Origin so the request passes the Origin guard
    // and actually reaches backend selection.
    VERCEL_URL: PREVIEW_HOST,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

// Routes whose input guards run before backend selection need a well-formed
// request to reach the resolver at all; a generic body is refused earlier.
// Cron-only routes (dues-reminders-dispatch, dues-stripe-reconcile,
// organization-exports, task-files-reconcile) refuse an ordinary request before
// resolution by design and are covered by the generic request.
const FIXTURES = {
  "private-files": { body: { kind: "task", fileId: "10000000-0000-4000-8000-000000000001" } },
  "sensitive-case-files": { body: { action: "read", fileId: "10000000-0000-4000-8000-000000000001" } },
  "calendar": { query: { token: "t".repeat(40) } },
};

function request(method, route) {
  const fixture = FIXTURES[route] || {};
  const body = method === "GET" ? undefined : (fixture.body || {});
  return {
    method,
    url: `/api/example?status=1`,
    query: { status: "1", ...(fixture.query || {}) },
    headers: {
      host: PREVIEW_HOST,
      origin: `https://${PREVIEW_HOST}`,
      authorization: "Bearer member-token",
      "content-type": "application/json",
    },
    body,
    // Routes that stream the raw body iterate the request; give them an empty stream.
    async *[Symbol.asyncIterator]() {},
    on() { return this; },
  };
}

const PERMITTED_STATUSES = new Set([200, 204, 302, 400, 401, 403, 404, 405, 409, 410, 415, 422, 429, 503]);

// The assertion shared by every route: the handler settled without throwing,
// answered an explicit fail-closed status, and neither its outbound calls nor
// its response carry a production credential.
export function assertFailClosed(route, method, outcome, res, fetcher) {
  expect(outcome, `${route} ${method} must settle without throwing (got ${JSON.stringify(outcome)})`).toBe("settled");
  expect(PERMITTED_STATUSES.has(res.statusCode), `${route} ${method} answered status ${res.statusCode}`).toBe(true);
  const transcript = JSON.stringify({ calls: fetcher.mock.calls, status: res.statusCode, body: res.body, headers: res.headers });
  for (const marker of PRODUCTION_MARKERS) {
    expect(transcript, `${route} ${method} leaked ${marker}`).not.toContain(marker);
  }
  // A refused backend has no URL, so nothing may have been asked of the
  // production origin either directly or through a relative Supabase path.
  for (const [url] of fetcher.mock.calls) {
    expect(String(url).startsWith(PRODUCTION_URL), `${route} ${method} fetched ${url}`).toBe(false);
  }
}

async function drive(handler, req, res) {
  let timer;
  const outcome = await Promise.race([
    Promise.resolve().then(() => handler(req, res)).then(() => "settled", (error) => ({ threw: String(error?.message || error) })),
    new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 5000); }),
  ]);
  clearTimeout(timer);
  return outcome;
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    getHeader(name) { return this.headers[name]; },
    end(body) { this.body = body === undefined ? "" : String(body); return this; },
    send(body) { return this.end(body); },
    json(body) { return this.end(JSON.stringify(body)); },
    redirect(code, location) { this.statusCode = typeof code === "number" ? code : 302; this.headers.location = location ?? code; return this; },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("demo-surface build on an unlisted preview host", () => {
  it("has an inventory of backend-selecting routes", () => {
    expect(callers.length).toBeGreaterThan(30);
    expect(callers).toContain("chapter-lifecycle-verification");
    // Union Ground has no membership card, so its API routes are gone.
    expect(callers).not.toContain("membership-card");
    expect(callers).not.toContain("membership-card-verify");
    expect(callers).toContain("demo-session");
  });

  it.each(callers)("%s never contacts production or emits production credentials", async (route) => {
    stubDemoSurfaceEnv();
    const fetcher = vi.fn(async (url) => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
      url: String(url),
    }));
    vi.stubGlobal("fetch", fetcher);
    // Vite resolves dynamic imports one directory level at a time.
    const [dir, name] = route.includes("/") ? route.split("/") : [null, route];
    const { default: handler } = dir ? await import(`../api/${dir}/${name}.js`) : await import(`../api/${name}.js`);

    for (const method of ["POST", "GET"]) {
      const res = response();
      const outcome = await drive(handler, request(method, route), res);
      assertFailClosed(route, method, outcome, res, fetcher);
    }
  });

  it("fails when a handler throws, answers no status, or leaks a production credential", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const quiet = response();
    expect(() => assertFailClosed("fake", "POST", { threw: "production-service-key" }, quiet, fetcher)).toThrow(/must settle/);
    expect(() => assertFailClosed("fake", "POST", "settled", quiet, fetcher)).toThrow(/answered status 0/);
    const leaking = response().status(503).end(JSON.stringify({ hint: "production-service-key" }));
    expect(() => assertFailClosed("fake", "POST", "settled", leaking, fetcher)).toThrow(/leaked production-service-key/);
    const productionFetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await productionFetch(`${PRODUCTION_URL}/auth/v1/user`);
    expect(() => assertFailClosed("fake", "POST", "settled", response().status(401).end("{}"), productionFetch)).toThrow(/leaked/);
    const throwing = async () => { throw new Error("boom"); };
    expect(await drive(throwing, request("POST", "fake"), response())).toEqual({ threw: "boom" });
  });
});
