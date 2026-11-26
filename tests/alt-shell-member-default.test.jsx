import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030: the whole App on a live
// member session (the harness of sign-out-lands-home.test.jsx). The
// member-default-view flag is a stub here; tests/posthog-flags-surveys-heatmaps.test.js
// covers the real read and the exposure event. These pin who the flag decides
// for, that only then is the exposure requested, and the member's own switch.

const USER_ID = "00000000-0000-4000-8000-000000000611";
const session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: "10000000-0000-4000-8000-000000000001" }))}.sig`,
  refresh_token: "test-refresh-token",
  user: { id: USER_ID, email: "member@example.test", app_metadata: { roles: ["member"] }, user_metadata: {} },
};

const stubs = vi.hoisted(() => ({ loadShell: vi.fn(), loadRoute: vi.fn(), flag: { value: "control", reads: [] } }));

const supabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    admin: { signOut: vi.fn().mockResolvedValue({ error: null }) },
    mfa: { getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
  },
  realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
};

vi.mock("../src/lib/supabase.js", () => ({
  appBackendKind: "live",
  appBackendIsSampleProject: false,
  appAuthStorageKey: "test-auth-key",
  appAuthStorageUnavailable: false,
  appAuthSessionIsClosed: () => false,
  authStorageAdapter: () => localStorage,
  clearCapturedAppSessionLocally: vi.fn().mockResolvedValue(true),
  createCapturedAppSessionRpcClient: vi.fn(() => ({ rpc: vi.fn().mockResolvedValue({ data: { serverCleanupComplete: true }, error: null }) })),
  verifyCapturedAppSession: vi.fn(),
  hasAppBackend: true,
  appSupabase: supabase,
  supabase,
}));

vi.mock("../src/lib/useMemberFeatureFlag.js", () => ({
  useMemberFeatureFlag: (key, { exposed = true } = {}) => {
    stubs.flag.reads.push({ key, exposed });
    return key === "member-default-view" ? stubs.flag.value : "control";
  },
}));

vi.mock("../src/lib/memberSessionLoader.js", async (importOriginal) => ({
  ...await importOriginal(),
  createMemberSessionLoader: (_client, user) => ({
    userId: user.id,
    loadShell: stubs.loadShell,
    loadRoute: stubs.loadRoute,
    invalidateResources: vi.fn(),
    confirmRightsProgress: vi.fn(),
    failuresForResources: () => [],
    retryFailedResources: vi.fn(),
    subscribe: () => () => {},
    stateForRoute: () => ({ status: "loaded", error: "" }),
    noteLive: () => false,
    inspect: () => new Map(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../src/lib/memberApi.js", async (importOriginal) => ({
  ...await importOriginal(),
  subscribeToNotificationInserts: () => () => {},
  subscribeToChapterTaskBoard: () => () => {},
}));

vi.mock("../src/lib/outbox.js", async (importOriginal) => ({
  ...await importOriginal(),
  createOutboxStore: () => ({}),
  pendingCount: vi.fn().mockResolvedValue(0),
  replayQueue: vi.fn().mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false }),
  deleteSnapshot: vi.fn().mockResolvedValue(undefined),
  purgeSensitiveEntries: vi.fn().mockResolvedValue(undefined),
}));

vi.stubEnv("MODE", "production");
const [{ App }, { fallbackData }] = await Promise.all([
  import("../src/App.jsx"),
  import("./fixtures/retired-pre-bot/src/data/fallback.js"),
]);

const PREFERENCE_KEY = `ug.shell.member.${USER_ID}`;

function memberData({ roles = [], organizationRoles = [] } = {}) {
  return {
    ...fallbackData,
    roles,
    rolesUnknown: false,
    member: { ...fallbackData.member, id: USER_ID, organizationId: "org", chapterId: "chapter", membershipStatus: "active", organizationRoles, chapterRoles: [] },
  };
}

const appRoot = () => document.querySelector(".sg-app");
const flagDecided = () => stubs.flag.reads.some((read) => read.key === "member-default-view" && read.exposed);
const lastShellRead = () => stubs.flag.reads.filter((read) => read.key === "member-default-view").at(-1);

async function renderMember(data = memberData()) {
  stubs.loadShell.mockResolvedValue(data);
  stubs.loadRoute.mockResolvedValue(data);
  render(<App />);
  // The member's data has loaded once the first-name greeting or Now page is up.
  await waitFor(() => expect(stubs.loadShell).toHaveBeenCalled(), { timeout: runnerTimeout(10_000) });
  await act(async () => { for (let pass = 0; pass < 20; pass += 1) await Promise.resolve(); });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  stubs.flag.value = "control";
  stubs.flag.reads = [];
  supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
  window.scrollTo = vi.fn();
  window.history.replaceState({}, "", "/m");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("the alternate shell as the A/B member default view", () => {
  it("lands a member served alt in the alternate shell and asks for the exposure", async () => {
    stubs.flag.value = "alt";
    await renderMember();
    await waitFor(() => expect(appRoot()).toHaveAttribute("data-shell", "alt"), { timeout: runnerTimeout(10_000) });
    expect(flagDecided()).toBe(true);
  }, runnerTimeout(30_000));

  it("keeps a member served control on today's view and still asks for the exposure", async () => {
    await renderMember();
    await waitFor(() => expect(lastShellRead()?.exposed).toBe(true), { timeout: runnerTimeout(10_000) });
    expect(appRoot()).not.toHaveAttribute("data-shell");
  }, runnerTimeout(30_000));

  it.each([
    ["a staff role", { roles: ["steward"] }],
    ["an organization-wide role", { organizationRoles: ["admin"] }],
  ])("keeps an account with %s on its current shell and never asks for the exposure", async (_label, roles) => {
    stubs.flag.value = "alt";
    await renderMember(memberData(roles));
    await waitFor(() => expect(stubs.loadRoute.mock.calls.length + stubs.loadShell.mock.calls.length).toBeGreaterThan(0));
    expect(appRoot()).not.toHaveAttribute("data-shell");
    expect(flagDecided()).toBe(false);
  }, runnerTimeout(30_000));

  it("lets the member switch back to classic, remembers it, and stops the flag deciding", async () => {
    stubs.flag.value = "alt";
    await renderMember();
    await waitFor(() => expect(appRoot()).toHaveAttribute("data-shell", "alt"), { timeout: runnerTimeout(10_000) });
    // The root takes data-shell at once, but AltShell is a lazy view: its side
    // panel mounts only when that chunk resolves, which a crowded shard can
    // delay past the root's render (#8398, run 43182633916).
    const side = within(await waitFor(() => { const node = document.getElementById("ug-side"); expect(node).not.toBeNull(); return node; }, { timeout: runnerTimeout(10_000) }));
    fireEvent.click(await side.findByRole("button", { name: "Switch to classic view" }));
    await waitFor(() => expect(appRoot()).not.toHaveAttribute("data-shell"));
    expect(localStorage.getItem(PREFERENCE_KEY)).toBe("classic");
    expect(lastShellRead().exposed).toBe(false);
  }, runnerTimeout(30_000));

  it("honours the member's stored choice over the flag on the next visit", async () => {
    localStorage.setItem(PREFERENCE_KEY, "alt");
    await renderMember();
    await waitFor(() => expect(appRoot()).toHaveAttribute("data-shell", "alt"), { timeout: runnerTimeout(10_000) });
    expect(flagDecided()).toBe(false);
  }, runnerTimeout(30_000));

  it("offers no Work tab to a staff account while it wears the Member hat (Codex finding on #6533)", async () => {
    // Under Member the Tasks route refuses (explicitHatAllowsView), so the tab
    // bar offers Work only while an authorized staff hat is worn.
    window.history.replaceState({}, "", "/m?shell=alt");
    await renderMember(memberData({ roles: ["steward"] }));
    const tabbar = await waitFor(() => { const node = document.getElementById("ug-tabbar"); expect(node).not.toBeNull(); return node; }, { timeout: runnerTimeout(10_000) });
    expect(within(tabbar).getByRole("link", { name: /^Now/ })).toBeInTheDocument();
    expect(within(tabbar).getByRole("link", { name: /^Messages/ })).toBeInTheDocument();
    expect(within(tabbar).queryByRole("link", { name: /^Work/ })).toBeNull();
  }, runnerTimeout(30_000));

  it("keeps an explicit ?shell= query first, and the switch clears it", async () => {
    stubs.flag.value = "alt";
    window.history.replaceState({}, "", "/m?shell=classic");
    await renderMember();
    await waitFor(() => expect(stubs.loadShell).toHaveBeenCalled());
    expect(appRoot()).not.toHaveAttribute("data-shell");
    expect(flagDecided()).toBe(false);
    // Classic Settings carries the switch to the new view.
    window.history.replaceState({}, "", "/m/settings?shell=classic");
    window.dispatchEvent(new PopStateEvent("popstate"));
    fireEvent.click(await screen.findByRole("button", { name: "Try the new view" }, { timeout: runnerTimeout(10_000) }));
    await waitFor(() => expect(appRoot()).toHaveAttribute("data-shell", "alt"));
    expect(localStorage.getItem(PREFERENCE_KEY)).toBe("alt");
    expect(new URLSearchParams(window.location.search).has("shell")).toBe(false);
  }, runnerTimeout(30_000));
});
