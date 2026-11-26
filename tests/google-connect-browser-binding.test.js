// @vitest-environment node
// #9557: the organization calendar and Drive connects finish only in the
// browser that started them. The fake backend keeps the claim functions' rules
// (hash the state given, delete on use, refuse once expired).
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activationsHandler from "../api/google-activations.js";
import driveHandler from "../api/google-drive.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const backendUrl = SUPABASE_ORIGIN;
let store;
let stored;

const flows = [
  {
    name: "organization calendar", handler: activationsHandler, startAction: "calendar-start", callbackAction: "calendar-callback",
    redirectUri: `${PORTAL_ORIGIN}/api/google-activations?action=calendar-callback`, redirectEnv: "GOOGLE_ORG_CALENDAR_REDIRECT_URI", cookieName: "org_calendar_oauth_binding",
    page: `${PORTAL_ORIGIN}/m/integrations?calendar_push=`, scope: "openid email https://www.googleapis.com/auth/calendar.events",
  },
  {
    name: "Google Drive", handler: driveHandler, startAction: "start", callbackAction: "callback",
    redirectUri: `${PORTAL_ORIGIN}/api/google-drive?action=callback`, redirectEnv: "GOOGLE_DRIVE_REDIRECT_URI", cookieName: "google_drive_oauth_binding",
    page: `${PORTAL_ORIGIN}/m/organize?drive=`, scope: "openid email https://www.googleapis.com/auth/drive.file",
  },
];

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

// The begin function files the state under the caller's own organization.
function fakeBackend(url, options = {}) {
  const target = String(url);
  const body = typeof options.body === "string" ? JSON.parse(options.body) : null;
  const rpc = target.startsWith(`${backendUrl}/rest/v1/rpc/`) ? target.slice(`${backendUrl}/rest/v1/rpc/`.length) : "";
  if (rpc.startsWith("begin_")) {
    const caller = String(options.headers?.Authorization || "").replace(/^Bearer /, "");
    store.push({ hash: body.p_state_hash, expiresAt: Date.parse(body.p_expires_at), organizationId: `org-of-${caller}`,
      userId: caller, codeVerifier: body.p_code_verifier, redirectUri: body.p_redirect_uri });
    return reply({ organizationId: `org-of-${caller}`, status: "requested" });
  }
  if (rpc.startsWith("claim_")) {
    const index = store.findIndex((row) => row.hash === sha256Hex(String(body.p_state)) && row.expiresAt > Date.now());
    if (index < 0) return reply({ code: "42501", message: "invalid oauth state" }, 403);
    const [{ hash: _hash, expiresAt: _expiresAt, ...claimed }] = store.splice(index, 1);
    return reply(claimed);
  }
  if (rpc.startsWith("complete_")) {
    stored.push(body);
    return reply({ status: "connected" });
  }
  if (target === "https://oauth2.googleapis.com/token") {
    const flow = flows.find((candidate) => candidate.redirectUri === options.body.get("redirect_uri"));
    return reply({ access_token: "fixture-access", refresh_token: "fixture-refresh-token-value", scope: flow.scope });
  }
  if (target.startsWith("https://www.googleapis.com/drive/")) return reply({ files: [{ id: "fixture-root" }] });
  throw new Error(`Unexpected external request ${target}`);
}

async function invoke(handler, { method = "POST", query = {}, headers = {} } = {}) {
  const response = {
    statusCode: 0, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = value === undefined ? undefined : JSON.parse(value); },
  };
  await handler({ method, query, body: "{}", headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, ...headers } }, response);
  return response;
}

// An administrator's browser starts with its own token and keeps the cookie.
async function startIn(flow, adminToken) {
  const response = await invoke(flow.handler, { query: { action: flow.startAction }, headers: { authorization: `Bearer ${adminToken}` } });
  expect(response.statusCode).toBe(200);
  const setCookie = String(response.headers["Set-Cookie"] || "");
  return { state: new URL(response.body.authorizationUrl).searchParams.get("state"), cookie: setCookie.split(";")[0], setCookie };
}

// The browser's cookie for this flow after a response: kept, replaced or cleared.
function jarAfter(jar, response) {
  const header = response.headers["Set-Cookie"];
  if (!header) return jar;
  return /Max-Age=0;/.test(header) ? "" : String(header).split(";")[0];
}

const returnTo = (flow, state, cookie) => invoke(flow.handler, {
  method: "GET", query: { action: flow.callbackAction, code: "fixture-code", state }, headers: { origin: "", ...(cookie ? { cookie } : {}) },
});

beforeEach(() => {
  store = [];
  stored = [];
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: backendUrl, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture",
    GOOGLE_ORG_CALENDAR_CLIENT_ID: "org-calendar-client", GOOGLE_ORG_CALENDAR_CLIENT_SECRET: "s".repeat(24),
    GOOGLE_ORG_CALENDAR_REDIRECT_URI: flows[0].redirectUri,
    GOOGLE_DRIVE_CLIENT_ID: "drive-client", GOOGLE_DRIVE_CLIENT_SECRET: "drive-secret", GOOGLE_DRIVE_REDIRECT_URI: flows[1].redirectUri,
  })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(fakeBackend));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(flows)("the $name connect is tied to the browser that started it", (flow) => {
  it("sets a short-lived HttpOnly binding cookie scoped to the return address", async () => {
    const { setCookie, state } = await startIn(flow, "admin-a");
    expect(setCookie).toMatch(new RegExp(`^${flow.cookieName}=[A-Za-z0-9_-]{43}; Path=${new URL(flow.redirectUri).pathname}; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`));
    // The state Google carries is not enough on its own to claim the start.
    expect(store[0].hash).not.toBe(sha256Hex(state));
    expect(store[0].expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it("finishes in the starting browser for its organization and spends the cookie", async () => {
    const browser = await startIn(flow, "admin-a");
    const response = await returnTo(flow, browser.state, browser.cookie);
    expect(response).toMatchObject({ statusCode: 302, headers: { Location: `${flow.page}connected` } });
    expect(response.headers["Set-Cookie"]).toMatch(new RegExp(`^${flow.cookieName}=; .*Max-Age=0;`));
    expect(stored).toEqual([expect.objectContaining({ p_organization_id: "org-of-admin-a", p_user_id: "admin-a" })]);
  });

  it("refuses the link in another browser (no or malformed cookie), says nothing, stores nothing", async () => {
    const browser = await startIn(flow, "admin-a");
    for (const cookie of ["", `${flow.cookieName}=not-a-binding; other=1`]) {
      const elsewhere = await returnTo(flow, browser.state, cookie);
      expect(elsewhere).toMatchObject({ statusCode: 302, headers: { Location: `${flow.page}failed` }, body: undefined });
    }
    expect(stored).toEqual([]);
    expect(store).toHaveLength(1); // nothing claimed: the administrator can still finish
    expect(console.error.mock.calls.at(-1)[1]).toEqual({ kind: "callback_refused", reason: "browser_binding_missing" });
    expect(JSON.stringify(console.error.mock.calls)).not.toContain(browser.state);
  });

  it("refuses a return with another session's cookie and stores nothing", async () => {
    const victimLink = await startIn(flow, "admin-a");
    const otherSession = await startIn(flow, "admin-b");
    expect((await returnTo(flow, victimLink.state, otherSession.cookie)).headers.Location).toBe(`${flow.page}failed`);
    expect(stored).toEqual([]);
    // Each browser still finishes its own start.
    expect((await returnTo(flow, otherSession.state, otherSession.cookie)).headers.Location).toBe(`${flow.page}connected`);
    expect((await returnTo(flow, victimLink.state, victimLink.cookie)).headers.Location).toBe(`${flow.page}connected`);
    expect(stored.map((row) => row.p_organization_id)).toEqual(["org-of-admin-b", "org-of-admin-a"]);
  });

  // Round 1 r2g1 and r1s1 at 52e12005: a callback cleared the binding before
  // its claim, so a stray or stale return voided a connect still in progress.
  it("keeps the starting browser's binding through a stray or refused return", async () => {
    const browser = await startIn(flow, "admin-a");
    let jar = browser.cookie;
    for (const stray of [
      { action: flow.callbackAction, error: "access_denied" },
      { action: flow.callbackAction, code: "fixture-code", state: "invented-state" },
    ]) {
      const response = await invoke(flow.handler, { method: "GET", query: stray, headers: { origin: "", cookie: jar } });
      expect(response.headers).toMatchObject({ Location: `${flow.page}failed` });
      expect(response.headers["Set-Cookie"]).toBeUndefined();
      jar = jarAfter(jar, response);
    }
    expect((await returnTo(flow, browser.state, jar)).headers.Location).toBe(`${flow.page}connected`);
  });

  it("keeps a newer connect's binding when an older link from the same browser returns", async () => {
    const older = await startIn(flow, "admin-a");
    const newer = await startIn(flow, "admin-a");
    let jar = newer.cookie;
    const stale = await returnTo(flow, older.state, jar);
    expect(stale.headers.Location).toBe(`${flow.page}failed`);
    expect(stale.headers["Set-Cookie"]).toBeUndefined();
    jar = jarAfter(jar, stale);
    const finished = await returnTo(flow, newer.state, jar);
    expect(finished.headers.Location).toBe(`${flow.page}connected`);
    expect(jarAfter(jar, finished)).toBe("");
    expect(stored).toHaveLength(1);
  });

  it("refuses a replayed return even from the starting browser", async () => {
    const browser = await startIn(flow, "admin-a");
    expect((await returnTo(flow, browser.state, browser.cookie)).headers.Location).toBe(`${flow.page}connected`);
    expect((await returnTo(flow, browser.state, browser.cookie)).headers.Location).toBe(`${flow.page}failed`);
    expect(stored).toHaveLength(1);
  });

  it("refuses a return after the start has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
    const browser = await startIn(flow, "admin-a");
    vi.setSystemTime(new Date("2026-11-22T12:10:01Z"));
    expect((await returnTo(flow, browser.state, browser.cookie)).headers.Location).toBe(`${flow.page}failed`);
    expect(stored).toEqual([]);
  });

  it("refuses a browser start on an unapproved host before storing anything", async () => {
    vi.stubEnv("VERCEL_URL", "union-ground-preview.vercel.app");
    const response = await invoke(flow.handler, { query: { action: flow.startAction }, headers: {
      authorization: "Bearer admin-a", host: "union-ground-preview.vercel.app", origin: "https://union-ground-preview.vercel.app",
    } });
    expect(response).toMatchObject({ statusCode: 403, body: { error: "untrusted-origin" } });
    expect(response.headers["Set-Cookie"]).toBeUndefined();
    expect(store).toEqual([]);
  });

  it("keeps a www return address separate when no redirect is configured", async () => {
    const redirectUri = flow.redirectUri.replace("https://", "https://www.");
    vi.stubEnv(flow.redirectEnv, redirectUri);
    const response = await invoke(flow.handler, { query: { action: flow.startAction }, headers: { authorization: "Bearer admin-a" } });
    expect(response).toMatchObject({ statusCode: 409, body: { error: "use-site-address", siteAddress: new URL(redirectUri).origin } });
    expect(response.headers["Set-Cookie"]).toBeUndefined();
    expect(store).toEqual([]);
  });
});
