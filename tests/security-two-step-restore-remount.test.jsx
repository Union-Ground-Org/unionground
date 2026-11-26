import { capturedAppClientFixture, capturedAppAccountFixture } from "./helpers/capturedAppClientFixture.js";
// BUG-UG-SECURITY-PAGE-LOOPS-RESTORING-STAFF-ROLES-20261111 (#8222):
// after two-step verification on Settings → Security, staff saw the page
// remount between "Restoring your staff roles…" and loading, losing shown
// recovery codes, until a reload. A verification or token refresh keeps the
// current-login panel mounted while the authenticator assurance read settles.
// A distinct login must clear the earlier login's codes and form fields.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { applyDeviceParityState, clearDeviceParityState } from "../src/lib/deviceParity.js";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
let minted = 0;
// A one-time-code sign-in; verification adds totp at aal2. Each mint is a
// distinct token string for the same session.
const token = (aal, sessionId = SESSION_ID) => `e30.${Buffer.from(JSON.stringify({
  sub: "local-staff", aal, session_id: sessionId, n: (minted += 1),
  amr: aal === "aal2" ? [{ method: "totp" }, { method: "otp" }] : [{ method: "otp" }],
})).toString("base64url")}.local`;

const backend = vi.hoisted(() => {
  const factor = { id: "local-totp", factor_type: "totp", status: "verified" };
  const state = {
    data: null, session: null, enrolled: false, listeners: [], factorReads: 0, routeLoads: 0,
    assuranceChecks: 0, assurance: null, afterVerify: null, token: null, readerCalls: [],
  };
  const client = {
    auth: {
      setSession: async (candidate) => {
        if (candidate.access_token !== state.session?.access_token) throw new Error('Fixture adoption mismatch');
        return { data: { session: state.session }, error: null };
      },
      getSession: async () => ({ data: { session: state.session }, error: null }),
      getUser: async () => ({ data: { user: state.session?.user }, error: null }),
      onAuthStateChange: (callback) => {
        state.listeners.push(callback);
        return { data: { subscription: { unsubscribe() { state.listeners = state.listeners.filter((entry) => entry !== callback); } } } };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          state.assuranceChecks += 1;
          if (state.assurance) return state.assurance();
          const level = state.enrolled ? "aal2" : "aal1";
          return { data: { currentLevel: level, nextLevel: level }, error: null };
        },
        // Each mount of the two-step panel reads the factor list once.
        listFactors: async () => {
          state.factorReads += 1;
          const all = state.enrolled ? [factor] : [];
          return { data: { all, totp: all }, error: null };
        },
        enroll: async () => ({ data: { id: factor.id, totp: { qr_code: "", secret: "SYNTHETIC" } }, error: null }),
        challenge: async () => ({ data: { id: "local-challenge" }, error: null }),
        unenroll: async () => ({ error: null }),
        // Supabase stores the aal2 token for the same session and tells every
        // listener before verify resolves.
        verify: async () => {
          state.enrolled = true;
          state.session = { ...state.session, access_token: state.token("aal2"), user: { ...state.session.user, factors: [factor] } };
          state.data = state.afterVerify;
          for (const listener of state.listeners) await listener("MFA_CHALLENGE_VERIFIED", state.session);
          return { data: state.session, error: null };
        },
      },
    },
    rpc: vi.fn(async (name) => {
      state.readerCalls.push(name);
      // #9272: real optional captured readers succeed, as they can for a
      // signed-in person. Their settlement must not remount Security.
      if (name === "get_organization_learning_period") return { data: { organizationId: "local-org", used: false, running: false }, error: null };
      if (name === "generate_mfa_recovery_codes") return { data: { codes: ["synthetic-code-1", "synthetic-code-2"], generation: 1 }, error: null };
      return { data: null, error: null };
    }),
    from: () => { let query; query = new Proxy({}, { get: (_target, key) => key === "then"
      ? (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject) : () => query }); return query; },
    channel: () => { const channel = { on: () => channel, subscribe: () => channel, unsubscribe() {} }; return channel; },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, client };
});
vi.mock("../src/lib/supabase.js", async (original) => {
  const implementation = await original();
  return {
  ...implementation, hasAppBackend: true, appAuthStorageUnavailable: false, appBackendKind: "live", appSupabase: backend.client,
  createCapturedAppAccountClient: async () => capturedAppAccountFixture(backend.client),
  // Successful optional readers must preserve the Security controller scope (#9272).
  createCapturedAppSessionRpcClient: (session, options) => options?.boundedTransport
    ? capturedAppClientFixture(backend.client) : backend.client,
  };
});
vi.mock("../src/lib/memberSessionLoader.js", async (original) => ({
  ...await original(),
  createMemberSessionLoader: (_client, user) => ({
    userId: user.id,
    loadShell: async () => backend.state.data,
    loadRoute: async () => { backend.state.routeLoads += 1; return backend.state.data; },
    invalidateResources() {}, resourcesForRoute: () => [], failuresForResources: () => [],
    subscribe: () => () => {}, inspect: () => ({ status: "loaded" }),
    stateForRoute: () => ({ status: "loaded", error: "" }), retryFailedResources() {}, dispose() {},
  }),
}));
vi.mock("../src/views/TodayView.jsx", () => ({ TodayView: () => <h1>Entered Member Home</h1> }));

function memberData(roles, staffMfa) {
  return {
    ...structuredClone(fallbackData), roles, rolesUnknown: false, staffMfa,
    member: { ...fallbackData.member, id: "local-staff", organizationId: "local-org", organizationRoles: ["admin"], chapterRoles: [], language: "en", membershipStatus: "active" },
  };
}
const paused = { required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["admin"] };
const restored = { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] };
const buttonNamed = (text) => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
const challengeShown = () => document.querySelector("#mfa-challenge-title") !== null;
const assurance = (currentLevel, nextLevel = currentLevel) => ({ data: { currentLevel, nextLevel }, error: null });

async function openSecurity() {
  render(<App />);
  await waitFor(() => expect(buttonNamed("Turn on two-step sign-in")).toBeTruthy(), { timeout: 10000 });
}

async function verifyTwoStep() {
  await act(async () => { fireEvent.click(buttonNamed("Turn on two-step sign-in")); });
  const code = await waitFor(() => {
    const field = document.querySelector("form.mfa-enroll input");
    expect(field).toBeTruthy();
    return field;
  });
  fireEvent.change(code, { target: { value: "123456" } });
  await act(async () => { fireEvent.submit(code.closest("form")); });
}

beforeEach(() => {
  vi.stubEnv("MODE", "local-auth-navigation-proof");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No hosted requests in local proof")));
  window.scrollTo = vi.fn(); localStorage.clear(); sessionStorage.clear(); clearDeviceParityState();
  globalThis.jsdom.reconfigure({ url: `${PORTAL_ORIGIN}/m/settings/security` });
  applyDeviceParityState("app.selectedStaffHat", "member");
  Object.assign(backend.state, {
    enrolled: false, listeners: [], factorReads: 0, routeLoads: 0, assuranceChecks: 0, assurance: null, token, readerCalls: [],
    data: memberData([], paused), afterVerify: memberData(["admin"], restored),
    session: { user: { id: "local-staff", email: "fictional-staff@example.invalid", factors: [] }, access_token: token("aal1"), refresh_token: "local-only" },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); clearDeviceParityState(); });

describe("two-step verification on Security restores staff roles without remounting the page", () => {
  it("retains the code being typed into setup through a same-session reader recheck", async () => {
    await openSecurity();
    await act(async () => { fireEvent.click(buttonNamed("Turn on two-step sign-in")); });
    const code = document.querySelector("form.mfa-enroll input");
    expect(code).toBeTruthy();
    fireEvent.change(code, { target: { value: "123456" } });
    await act(async () => {
      backend.state.session = { ...backend.state.session, access_token: token("aal1") };
      for (const listener of backend.state.listeners) await listener("TOKEN_REFRESHED", backend.state.session);
    });
    expect(document.querySelector("form.mfa-enroll input")).toBe(code);
    expect(code).toHaveValue("123456");
    await act(async () => { fireEvent.submit(code.closest("form")); });
    await screen.findByText("On — you'll be asked for a code from your authenticator app.");
    expect(backend.state.factorReads).toBe(2);
  }, 20000);

  it("keeps the panel mounted through verification, restores the roles once and re-checks the new token", async () => {
    await openSecurity();
    expect(backend.state.factorReads).toBe(1);
    expect(backend.state.readerCalls).toContain("get_organization_learning_period");
    expect(backend.state.assuranceChecks).toBe(1);
    const loadsBefore = backend.state.routeLoads;
    await verifyTwoStep();
    await screen.findByText("On — you'll be asked for a code from your authenticator app.");
    await waitFor(() => expect(buttonNamed("Restore my staff roles")).toBeUndefined());
    expect(screen.queryByText("Restoring your staff roles…")).toBeNull();
    // One read on mount and one after the verify: the panel never remounted.
    expect(backend.state.factorReads).toBe(2);
    // The verify refreshes the standing itself, once.
    expect(backend.state.routeLoads - loadsBefore).toBe(1);
    // The aal2 token was still checked; it just kept the session's answer meanwhile.
    expect(backend.state.assuranceChecks).toBe(2);
    expect(challengeShown()).toBe(false);
  }, 20000);

  it("keeps shown recovery codes on screen when the same session's token is refreshed", async () => {
    await openSecurity();
    await verifyTwoStep();
    await screen.findByText("On — you'll be asked for a code from your authenticator app.");
    await act(async () => { fireEvent.click(buttonNamed("Generate recovery codes")); });
    await screen.findByText("synthetic-code-1");
    const password = document.querySelector('input[autocomplete="new-password"]');
    expect(password).toBeTruthy();
    fireEvent.change(password, { target: { value: "Unsubmitted-local-passphrase" } });
    let release;
    backend.state.assurance = () => new Promise((resolve) => { release = () => resolve(assurance("aal2")); });
    await act(async () => {
      backend.state.session = { ...backend.state.session, access_token: token("aal2") };
      for (const listener of backend.state.listeners) await listener("TOKEN_REFRESHED", backend.state.session);
    });
    // While the refreshed token is being checked the panel and codes stay.
    expect(challengeShown()).toBe(false);
    expect(screen.getByText("synthetic-code-1")).toBeInTheDocument();
    expect(password).toBeInTheDocument();
    expect(password).toHaveValue("Unsubmitted-local-passphrase");
    await act(async () => { release(); });
    expect(screen.getByText("synthetic-code-1")).toBeInTheDocument();
    expect(backend.state.factorReads).toBe(2);
  }, 20000);

  it("withholds security settings until the assurance answer and when a re-check requires a code", async () => {
    let release;
    backend.state.assurance = () => new Promise((resolve) => { release = () => resolve(assurance("aal1")); });
    render(<App />);
    await waitFor(() => expect(release).toEqual(expect.any(Function)));
    expect(buttonNamed("Turn on two-step sign-in")).toBeUndefined();
    await act(async () => { release(); });
    await waitFor(() => expect(buttonNamed("Turn on two-step sign-in")).toBeTruthy());
    backend.state.assurance = async () => assurance("aal1", "aal2");
    await act(async () => {
      const user = { ...backend.state.session.user, factors: [{ id: "local-totp", status: "verified", factor_type: "totp" }] };
      backend.state.session = { ...backend.state.session, user, access_token: token("aal1") };
      for (const listener of backend.state.listeners) await listener("TOKEN_REFRESHED", backend.state.session);
    });
    await waitFor(() => expect(challengeShown()).toBe(true));
    expect(buttonNamed("Turn on two-step sign-in")).toBeUndefined();
  }, 20000);

  it("clears shown codes and typed input for a distinct login by the same person", async () => {
    await openSecurity();
    await verifyTwoStep();
    await act(async () => { fireEvent.click(buttonNamed("Generate recovery codes")); });
    await screen.findByText("synthetic-code-1");
    const password = document.querySelector('input[autocomplete="new-password"]');
    fireEvent.change(password, { target: { value: "Unsubmitted-local-passphrase" } });
    let release;
    backend.state.assurance = () => new Promise((resolve) => { release = () => resolve(assurance("aal2")); });
    await act(async () => {
      backend.state.session = { ...backend.state.session, access_token: token("aal2", "99999999-2222-4333-8444-555555555555") };
      for (const listener of backend.state.listeners) await listener("SIGNED_IN", backend.state.session);
    });
    expect(screen.queryByText("synthetic-code-1")).toBeNull();
    expect(password).not.toBeInTheDocument();
    expect(buttonNamed("Generate recovery codes")).toBeUndefined();
    await act(async () => { release(); });
    await waitFor(() => expect(buttonNamed("Generate recovery codes")).toBeTruthy());
    expect(screen.queryByText("synthetic-code-1")).toBeNull();
    expect(document.querySelector('input[autocomplete="new-password"]')).toHaveValue("");
  }, 20000);
});
