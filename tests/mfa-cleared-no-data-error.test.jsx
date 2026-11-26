// BUG-UG-WEB-MFA-CLEARED-FLASHES-DATA-ERROR-20261003: the boot load
// ran at aal1 while the two-step challenge was up, failed and set the data
// error; clearing the challenge then showed "Campaign data is unavailable" until
// the post-challenge refresh committed.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  loadShell: vi.fn(),
  loadRoute: vi.fn(),
  pendingCount: vi.fn(),
  replayQueue: vi.fn(),
  saveRightsProgress: vi.fn(),
  captureSanitizedDiagnostic: vi.fn(() => true),
  clearMfa: null,
}));

const session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000201" }))}.sig`,
  refresh_token: "test-refresh-token",
  user: {
    id: "member-1",
    email: "member@example.test",
    app_metadata: { roles: ["member"] },
    user_metadata: {},
    // A verified TOTP factor at aal1: this member owes the two-step check.
    factors: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
  },
};

const supabase = {
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
        data: { currentLevel: "aal1", nextLevel: "aal2" },
        error: null,
      }),
    },
  },
  realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
};

vi.mock("../src/lib/supabase.js", () => ({
  appBackendKind: "live",
  appBackendIsSampleProject: false,
  appAuthStorageKey: "test-auth-key",
  appAuthStorageUnavailable: false,
  appAuthSessionIsClosed: () => false,
  authStorageAdapter: () => globalThis.localStorage,
  clearCapturedAppSessionLocally: vi.fn(),
  createCapturedAppSessionRpcClient: () => supabase,
  createCapturedAppAccountClient: async () => supabase,
  verifyCapturedAppSession: vi.fn(),
  hasAppBackend: true,
  appSupabase: supabase,
}));

vi.mock("../src/lib/memberSessionLoader.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createMemberSessionLoader: (_client, user) => ({
      userId: user.id,
      loadShell: stubs.loadShell,
      loadRoute: stubs.loadRoute,
      invalidateResources: vi.fn(),
      resourcesForRoute: () => [],
      confirmRightsProgress: vi.fn(),
      failuresForResources: () => [],
      retryFailedResources: vi.fn(),
      subscribe: () => () => {},
      stateForRoute: () => ({ status: "loaded", error: "" }),
      noteLive: () => false,
      inspect: () => new Map(),
      dispose: vi.fn(),
    }),
  };
});

vi.mock("../src/lib/memberApi.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    subscribeToNotificationInserts: () => () => {},
    subscribeToChapterTaskBoard: () => () => {},
    saveRightsProgress: stubs.saveRightsProgress,
  };
});

// The write's follow-up refresh failure is reported through the sanitized
// diagnostic channel PR #2040 added, never as page copy.
vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, captureSanitizedDiagnostic: stubs.captureSanitizedDiagnostic };
});

vi.mock("../src/lib/outbox.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createOutboxStore: () => ({}),
    pendingCount: stubs.pendingCount,
    replayQueue: stubs.replayQueue,
  };
});

// The challenge's own network flow is MfaSettings' concern; here it is a
// button that reports the check as answered.
vi.mock("../src/components/MfaSettings.jsx", () => ({
  MfaChallenge: ({ onCleared }) => {
    stubs.clearMfa = onCleared;
    return <><input aria-label="Code from your app" /><button type="button" onClick={onCleared}>Answer the two-step check</button></>;
  },
  MfaSettings: () => null,
  MfaEnrollment: ({ onCleared }) => <button onClick={() => { void onCleared().catch(() => {}); }}>Set up required two-step</button>,
}));

vi.stubEnv("MODE", "production");
const [{ App }, { fallbackData }] = await Promise.all([
  import("../src/App.jsx"),
  import("./fixtures/retired-pre-bot/src/data/fallback.js"),
]);

afterEach(() => {
  vi.clearAllMocks();
  supabase.rpc.mockResolvedValue({ data: null, error: null });
  window.history.replaceState({}, "", "/");
});

it("offers enrollment before protected data for an organization-required member without a factor", async () => {
  window.history.replaceState({}, "", "/m");
  supabase.auth.getSession.mockResolvedValueOnce({ data: { session: { ...session, access_token: `header.${btoa(JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000201" }))}.sig`, user: { ...session.user, factors: [] } } }, error: null });
  supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null });
  supabase.rpc.mockImplementation(async (name) => ({ data: name === "get_my_mfa_requirement" ? { required: true, enrolled: false } : null, error: null }));
  stubs.loadShell.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
  stubs.loadRoute.mockResolvedValue({ ...fallbackData, member: { ...fallbackData.member, id: session.user.id } });
  render(<App />);
  const enroll = await screen.findByRole("button", { name: "Set up required two-step" });
  expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull();
  fireEvent.click(enroll);
  await settle();
  expect(stubs.loadRoute).toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull();
});

it("offers retry and sign-out when the post-enrollment member refresh fails", async () => {
  window.history.replaceState({}, "", "/m");
  supabase.auth.getSession.mockResolvedValueOnce({ data: { session: { ...session, access_token: `header.${btoa(JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000201" }))}.sig`, user: { ...session.user, factors: [] } } }, error: null });
  supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null });
  supabase.rpc.mockImplementation(async (name) => ({ data: name === "get_my_mfa_requirement" ? { required: true, enrolled: false } : null, error: null }));
  stubs.loadShell.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
  stubs.loadRoute.mockRejectedValue(new Error("post-enrollment unavailable"));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up required two-step" }));
  expect(await screen.findByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
});

const settle = () => act(async () => { for (let pass = 0; pass < 20; pass += 1) await Promise.resolve(); });

it("goes from the challenge to loading to the app without the data-error screen", async () => {
  window.history.replaceState({}, "", "/m");
  // The aal1 boot load is refused by the assurance boundary.
  stubs.loadShell.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
  stubs.pendingCount.mockResolvedValue(0);
  stubs.replayQueue.mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false });
  let resolveRoute;
  stubs.loadRoute.mockImplementation(() => new Promise((resolve) => { resolveRoute = resolve; }));

  render(<App />);
  const answer = await screen.findByRole("button", { name: "Answer the two-step check" });
  await settle();
  expect(stubs.loadShell).toHaveBeenCalled();

  const before = stubs.loadShell.mock.calls.length;
  fireEvent.click(answer);
  await settle();
  expect(stubs.loadShell.mock.calls.length).toBe(before);
  expect(stubs.loadRoute).toHaveBeenCalled();
  // Between the challenge and the app: loading, never the error card.
  expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading Union Ground");

  await act(async () => {
    resolveRoute({ ...fallbackData, member: { ...fallbackData.member, id: session.user.id } });
    for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
  });
  expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull();
  expect(document.querySelector(".data-error")).toBeNull();
});

it("still shows the data-error screen when the refresh after the challenge fails", async () => {
  window.history.replaceState({}, "", "/m");
  stubs.loadShell.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
  stubs.pendingCount.mockResolvedValue(0);
  stubs.replayQueue.mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false });
  stubs.loadRoute.mockRejectedValue(new Error("upstream unavailable"));

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Answer the two-step check" }));
  expect(await screen.findByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
  expect(screen.queryByText("upstream unavailable")).toBeNull();
});

it("releases a superseded boot load when an in-flight MFA callback finishes after a new login", async () => {
  window.history.replaceState({}, "", "/m");
  const denied = Object.assign(new Error("permission denied"), { code: "42501" });
  stubs.loadShell.mockRejectedValue(denied);
  stubs.pendingCount.mockResolvedValue(0);
  stubs.replayQueue.mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false });
  stubs.loadRoute.mockResolvedValue({ ...fallbackData, member: { ...fallbackData.member, id: session.user.id } });
  render(<App />);
  await screen.findByRole("button", { name: "Answer the two-step check" });
  const finishChallenge = stubs.clearMfa;
  let rejectBoot;
  stubs.loadShell.mockImplementation(() => new Promise((_, reject) => { rejectBoot = reject; }));
  const authChanged = supabase.auth.onAuthStateChange.mock.calls.at(-1)[0];
  await act(async () => {
    authChanged("SIGNED_IN", { ...session, access_token: "new-login-token", refresh_token: "new-login-refresh" });
  });
  expect(rejectBoot).toBeTypeOf("function");
  expect(screen.getByRole("status")).toHaveTextContent("Loading Union Ground");
  await act(async () => { finishChallenge(); });
  await act(async () => { rejectBoot(denied); });
  expect(screen.queryByText(/Loading Union Ground/)).toBeNull();
  expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull();
});

it("does not remount a partially typed code when the same session refreshes", async () => {
  window.history.replaceState({}, "", "/m");
  stubs.loadShell.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));
  render(<App />);
  const input = await screen.findByLabelText("Code from your app");
  fireEvent.change(input, { target: { value: "012" } });
  const changed = supabase.auth.onAuthStateChange.mock.calls.at(-1)[0];
  let answer;
  supabase.auth.mfa.getAuthenticatorAssuranceLevel.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  await act(async () => changed("TOKEN_REFRESHED", { ...session, access_token: "refreshed-token" }));
  expect(screen.getByLabelText("Code from your app")).toBe(input);
  expect(input).toHaveValue("012");
  await act(async () => answer({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null }));
  expect(screen.getByLabelText("Code from your app")).toBe(input);
  fireEvent.change(input, { target: { value: input.value + "345" } });
  expect(input).toHaveValue("012345");
});
