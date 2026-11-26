// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 93: after
// Sign out the tab showed the public landing page ("Your union, in your
// pocket.") instead of sign-in once the page was reloaded. A tab whose visit
// ended with an explicit sign-out now reopens on the sign-in card; a fresh
// visit to / still gets the public landing page. Same App harness as
// sign-out-lands-home.test.jsx.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This edition's public front door is LearnView at "/" (src/views/LearnView.jsx);
// its wrapper marks the page.
const LANDING = ".public-site main#main-content";
const CARD_LINEAGE = "10000000-0000-4000-8000-000000000001";
const authStorageKey = "test-auth-key";

const session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: CARD_LINEAGE }))}.sig`,
  refresh_token: "test-refresh-token",
  user: { id: "00000000-0000-4000-8000-000000000611", email: "member@example.test", app_metadata: { roles: ["member"] }, user_metadata: {} },
};

const stubs = vi.hoisted(() => ({
  loadShell: vi.fn(),
  loadRoute: vi.fn(),
  requestAccountDeletion: vi.fn(),
  signOut: vi.fn().mockResolvedValue({ error: null }),
}));

const supabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signOut: stubs.signOut,
    admin: { signOut: vi.fn().mockResolvedValue({ error: null }) },
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }),
    },
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

vi.mock("../src/lib/accountLifecycleApi.js", async (importOriginal) => ({
  ...await importOriginal(),
  requestAccountDeletion: stubs.requestAccountDeletion,
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
const [{ App }, { App: RoutedApp }, { fallbackData }] = await Promise.all([
  import("../src/App.jsx"),
  import("../src/AppRouter.jsx"),
  import("./fixtures/retired-pre-bot/src/data/fallback.js"),
]);

const member = {
  ...fallbackData.member,
  id: session.user.id,
  organizationId: "org",
  chapterId: "chapter",
  membershipStatus: "active",
};
// Union Ground has no membership card, so only the session is seeded.
function seedSession() {
  localStorage.setItem(authStorageKey, JSON.stringify(session));
}

async function settle() {
  await act(async () => { for (let pass = 0; pass < 20; pass += 1) await Promise.resolve(); });
}


beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  const memberData = { ...fallbackData, member };
  stubs.loadShell.mockResolvedValue(memberData);
  stubs.loadRoute.mockResolvedValue(memberData);
  stubs.requestAccountDeletion.mockResolvedValue({ deleted: true, audited: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});


describe("sign-out lands on sign-in (#6578 finding 93)", () => {
  it("lands on the sign-in card, not the public landing page, and stays there after a reload", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings");
    const first = render(<App />);
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    await act(async () => { fireEvent.click(signOut); });
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    expect(document.querySelector(LANDING)).toBeNull();
    first.unmount();

    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<App />);
    await settle();
    expect(window.location.pathname).toBe("/");
    expect(document.querySelector(LANDING)).toBeNull();
    expect(screen.getByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    expect(screen.queryByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeNull();
  });

  // This edition's member shell has no landing page of its own: the router
  // (src/AppRouter.jsx) serves the Learn front door at "/" before the shell.
  it("still opens a fresh visit to / on the public front door", async () => {
    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    window.history.replaceState({}, "", "/");
    render(<RoutedApp />);
    await settle();
    expect(document.querySelector(LANDING)).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Sign in to Union Ground" })).toBeNull();
  });
});
