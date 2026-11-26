import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { samplePersonas } from "../src/lib/sampleBackend.js";
import { SAMPLE_HOST } from "./helpers/fictional-provider.js";

const { sampleOrigin } = vi.hoisted(() => ({ sampleOrigin: "https://sdkrefusalfixture.supabase.co" }));
vi.mock("../src/lib/sampleBackend.js", async (original) => ({
  ...await original(),
  isForbiddenSampleBackend: (origin) => origin !== sampleOrigin,
}));

// UX-UG-RETIRED-PREVIEW-INVITATION-20261020, gate round 3 on #5285
// : the refusal on the retired preview host must really
// remove the refused tuple from this browser, with the installed Supabase Auth
// SDK, the real exact-session storage adapter and the real App refusal chain.
// Only the HTTP transport is a controlled local fake; nothing here is hosted
// proof. A tuple whose access token carries no session id (a hand-set dummy
// token) has no lineage for the ordinary compare-and-swap to fence, so before
// this repair it stayed in the slot and the client's refresh could exchange
// its refresh token for a persona session later.

const persona = samplePersonas()[0];
const USER = "00000000-0000-4000-8000-000000000501";
const SESSION_ID = "00000000-0000-4000-8000-000000000601";

function jwt(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}
function tuple({ accessToken, refreshToken, email, expiresAt }) {
  return { access_token: accessToken, refresh_token: refreshToken, token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user: { id: USER, email, aud: "authenticated", role: "authenticated" } };
}
function withLocation(hostname, run) {
  const previous = window.location;
  window.history.replaceState({}, "", "/m");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...previous, hostname, get search() { return previous.search; }, get pathname() { return previous.pathname; }, get hash() { return previous.hash; } },
  });
  return Promise.resolve().then(run).finally(() => {
    Object.defineProperty(window, "location", { configurable: true, value: previous });
  });
}

describe("retired-host refusal with the installed Auth SDK and the real exact-session storage", () => {
  let app = null;
  beforeEach(() => { vi.resetModules(); cleanup(); localStorage.clear(); });
  afterEach(async () => {
    await app?.appSupabase?.auth.dispose?.();
    app = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  // The controlled transport: the refresh grant answers with whatever the
  // case says the server would mint; sign-out preparation and logout refuse.
  function transport({ refreshed }) {
    const calls = [];
    const request = vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const authorization = new Headers(init.headers).get("authorization");
      calls.push({ path: url.pathname, grant: url.searchParams.get("grant_type"), authorization, body: init.body ? String(init.body) : null });
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
        if (!refreshed) return new Response(JSON.stringify({ code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }), { status: 400, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
        return new Response(JSON.stringify(refreshed), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/rest/v1/rpc/prepare_my_signout") {
        return new Response(JSON.stringify({ code: "42501", message: "captured session unavailable" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/auth/v1/logout") {
        return new Response(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }), { status: 401, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
      }
      throw new Error(`No endpoint may be contacted on refusal: ${url.pathname}`);
    });
    return { request, calls };
  }

  async function boot({ stored, refreshed = null }) {
    const net = transport({ refreshed });
    vi.stubGlobal("fetch", net.request);
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", sampleOrigin);
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
    vi.doUnmock("../src/lib/demoVoiceParity.js");
    const forgetDepartedMemberDevice = vi.fn(async () => undefined);
    vi.doMock("../src/lib/outbox.js", async (importOriginal) => ({ ...(await importOriginal()), forgetDepartedMemberDevice }));
    const loadMemberApp = vi.fn(async () => { throw new Error("No member data may load on refusal"); });
    vi.doMock("../src/lib/memberApi.js", async (importOriginal) => ({ ...(await importOriginal()), loadMemberApp }));
    app = await import("../src/lib/supabase.js");
    expect(app.appBackendKind).toBe("sample");
    const key = app.appAuthStorageKey;
    localStorage.setItem(key, JSON.stringify(stored));
    const clientSignOut = vi.spyOn(app.appSupabase.auth, "signOut");
    const { App } = await import("../src/App.jsx");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
    return { key, net, loadMemberApp, clientSignOut, forgetDepartedMemberDevice };
  }

  it("removes an unexpired hand-set tuple from the slot so a later refresh has nothing to exchange", async () => {
    const stored = tuple({ accessToken: "hand-set-dummy-token", refreshToken: "refresh-dummy", email: persona.email, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const personaSession = tuple({ accessToken: jwt({ sub: USER, email: persona.email, session_id: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 }), refreshToken: "refresh-persona", email: persona.email, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    await withLocation(SAMPLE_HOST, async () => {
      const h = await boot({ stored, refreshed: personaSession });
      // The real adapter removed the exact refused tuple.
      await waitFor(() => expect(localStorage.getItem(h.key)).toBeNull());
      expect(h.loadMemberApp).not.toHaveBeenCalled();
      expect(h.clientSignOut).not.toHaveBeenCalled();
      // The revocation and the push teardown named the refused bearer only.
      await waitFor(() => expect(h.net.calls.some((call) => call.path === "/auth/v1/logout" && call.authorization === "Bearer hand-set-dummy-token")).toBe(true));
      expect(h.net.calls.some((call) => call.path === "/rest/v1/rpc/prepare_my_signout" && call.authorization === "Bearer hand-set-dummy-token")).toBe(true);
      expect(h.net.calls.filter((call) => call.grant === "refresh_token")).toEqual([]);
      // Late refresh: the installed SDK finds no session and never sends the
      // dummy tuple's refresh token to the server.
      const late = await app.appSupabase.auth.refreshSession();
      expect(late.data.session).toBeNull();
      const current = await app.appSupabase.auth.getSession();
      expect(current.data.session).toBeNull();
      expect(h.net.calls.filter((call) => call.grant === "refresh_token")).toEqual([]);
      expect(localStorage.getItem(h.key)).toBeNull();
      expect(h.loadMemberApp).not.toHaveBeenCalled();
    });
  });

  it("refuses the session the SDK refreshes at boot from an expired hand-set tuple and fences its lineage", async () => {
    const stored = tuple({ accessToken: "hand-set-dummy-token", refreshToken: "refresh-dummy", email: persona.email, expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const refreshedToken = jwt({ sub: USER, email: "retained@example.com", session_id: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    const refreshed = tuple({ accessToken: refreshedToken, refreshToken: "refresh-rotated", email: "retained@example.com", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    await withLocation(SAMPLE_HOST, async () => {
      const h = await boot({ stored, refreshed });
      // Boot refreshed before the App could refuse; the refreshed, lineage-
      // bearing session is what the refusal clears, by the ordinary fence.
      expect(h.net.calls.filter((call) => call.grant === "refresh_token")).toHaveLength(1);
      // Without Web Locks the fence is the proof and the inert raw tuple may
      // stay; the adapter answers nothing for it and the SDK sees no session.
      await waitFor(() => expect(app.appAuthSessionIsClosed(refreshed)).toBe(true));
      expect(app.authStorageAdapter().getItem(h.key) === null || JSON.parse(app.authStorageAdapter().getItem(h.key)).access_token === refreshedToken).toBe(true);
      await waitFor(() => expect(h.net.calls.some((call) => call.path === "/auth/v1/logout" && call.authorization === `Bearer ${refreshedToken}`)).toBe(true));
      expect(h.loadMemberApp).not.toHaveBeenCalled();
      expect(h.clientSignOut).not.toHaveBeenCalled();
      const current = await app.appSupabase.auth.getSession();
      expect(current.data.session).toBeNull();
    });
  });

  it("leaves a replacement session, a rotated same-lineage token and a rejecting slot to the ordinary rules", async () => {
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", sampleOrigin);
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
    await withLocation(SAMPLE_HOST, async () => {
      app = await import("../src/lib/supabase.js");
      const key = app.appAuthStorageKey;
      const refused = tuple({ accessToken: "hand-set-dummy-token", refreshToken: "refresh-dummy", email: persona.email, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      // Replacement B (another tab's persona session) occupies the slot: the
      // refused tuple no longer matches, so nothing is removed.
      const replacement = tuple({ accessToken: jwt({ sub: USER, email: persona.email, session_id: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 3600 }), refreshToken: "refresh-persona", email: persona.email, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      localStorage.setItem(key, JSON.stringify(replacement));
      expect(app.clearRefusedAppSessionLocally(refused, { explicitSignOut: true })).toBe(false);
      expect(localStorage.getItem(key)).toBe(JSON.stringify(replacement));
      // A changed refresh token or user beside the same dummy access token is
      // not the refused tuple either.
      localStorage.setItem(key, JSON.stringify({ ...refused, refresh_token: "refresh-rotated" }));
      expect(app.clearRefusedAppSessionLocally(refused, { explicitSignOut: true })).toBe(false);
      localStorage.setItem(key, JSON.stringify({ ...refused, user: { ...refused.user, id: "00000000-0000-4000-8000-000000000502" } }));
      expect(app.clearRefusedAppSessionLocally(refused, { explicitSignOut: true })).toBe(false);
      // The exact refused tuple: removed, no fence invented for a missing lineage.
      localStorage.setItem(key, JSON.stringify(refused));
      expect(app.clearRefusedAppSessionLocally(refused, { explicitSignOut: true })).toBe(true);
      expect(localStorage.getItem(key)).toBeNull();
      expect(Object.keys(localStorage).filter((name) => name.startsWith(key) && name !== key)).toEqual([]);
      // A lineage-bearing refused token keeps the ordinary compare-and-swap:
      // a rotated token of the same session is cleared and fenced.
      const first = tuple({ accessToken: jwt({ sub: USER, email: "retained@example.com", session_id: SESSION_ID, exp: 1 }), refreshToken: "r1", email: "retained@example.com", expiresAt: 1 });
      const rotated = tuple({ accessToken: jwt({ sub: USER, email: "retained@example.com", session_id: SESSION_ID, exp: 2 }), refreshToken: "r2", email: "retained@example.com", expiresAt: 2 });
      localStorage.setItem(key, JSON.stringify(rotated));
      expect(app.clearRefusedAppSessionLocally(first, { explicitSignOut: true })).toBe(true);
      expect(app.appAuthSessionIsClosed(rotated)).toBe(true);
    });
  });

  it("reports a resolved revocation error truthfully, still clears the refused tuple and never calls the mutable sign-out", async () => {
    const { retireRefusedSession } = await import("../src/lib/sampleBackend.js");
    const refused = tuple({ accessToken: "hand-set-dummy-token", refreshToken: "refresh-dummy", email: persona.email, expiresAt: 1 });
    const slot = { value: JSON.stringify(refused) };
    const result = await retireRefusedSession(refused, {
      prepareSignOut: async () => { throw new Error("rpc refused"); },
      revokeToken: async () => ({ data: null, error: { name: "AuthApiError", status: 401, code: "bad_jwt" } }),
      clearLocally: async () => { slot.value = null; return true; },
      afterCleared: async () => undefined,
    });
    expect(result).toEqual({ cleared: true, revoked: false });
    expect(slot.value).toBeNull();
    // A slot that rejects the removal is reported as not cleared; the chain
    // still ends without touching the client's current occupant.
    const rejected = await retireRefusedSession(refused, {
      prepareSignOut: async () => undefined,
      revokeToken: async () => ({ data: null, error: null }),
      clearLocally: () => { throw new Error("storage rejected the removal"); },
      afterCleared: async () => undefined,
    });
    expect(rejected).toEqual({ cleared: false, revoked: true });
  });
});
