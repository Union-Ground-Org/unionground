import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// BUG-UG-SIGN-IN-SCREEN-CARRIES-ANOTHER-PAGES-TAB-TITLE-20261122: a
// signed-out /m link (unionground.net/m/admin) showed the sign-in screen under
// the tab title "Union Ground | Member workspace", and / after signing out
// showed it under the landing page's title, because the head followed the
// address while the screen followed the session. The same live App harness as
// sign-out-lands-home.test.jsx, signed out at boot.

const CARD_LINEAGE = "10000000-0000-4000-8000-000000000001";
const authStorageKey = "test-auth-key";
const cardStorageKey = `${authStorageKey}.membership-card`;

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
  authListener: null,
}));

const supabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn((callback) => { stubs.authListener = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
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
const [{ App }, { fallbackData }, { loadLanguage }] = await Promise.all([
  import("../src/AppRouter.jsx"),
  import("./fixtures/retired-pre-bot/src/data/fallback.js"),
  import("../src/lib/i18n.js"),
]);

const member = {
  ...fallbackData.member,
  id: session.user.id,
  organizationId: "org",
  chapterId: "chapter",
  membershipStatus: "active",
};

async function settle() {
  await act(async () => { for (let pass = 0; pass < 20; pass += 1) await Promise.resolve(); });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.title = "stale";
  supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  supabase.rpc.mockImplementation(async (name) => ({ data: name === "get_my_legal_acceptance_state" ? { versions: currentLegalVersions() } : null, error: null }));
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  const memberData = { ...fallbackData, member };
  stubs.loadShell.mockResolvedValue(memberData);
  stubs.loadRoute.mockResolvedValue(memberData);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.removeItem("sg-lang");
  window.history.replaceState({}, "", "/");
});

describe("the sign-in screen's tab title", () => {
  it.each(["/m/admin", "/m/settings"])("names the sign-in screen on a signed-out %s link, then the workspace after sign-in without a reload", async (path) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 }, { timeout: 5000 })).toBeInTheDocument();
    await settle();
    expect(document.title).toBe("Sign in | Union Ground");
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    localStorage.setItem(authStorageKey, JSON.stringify(session));
    await act(async () => { stubs.authListener("SIGNED_IN", session); });
    expect(await screen.findByRole("link", { name: "Skip to main content" })).toBeInTheDocument();
    // The workspace's head: its page title once the heading renders, the
    // private fallback until then; never the sign-in screen's any more.
    await waitFor(() => expect(document.title).not.toMatch(/Sign in|Inicia sesión/));
    expect(document.title).toMatch(/Union Ground/);
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
  });

  it("names the sign-in screen in Spanish on a signed-out /m link", async () => {
    localStorage.setItem("sg-lang", "es");
    await loadLanguage("es");
    window.history.replaceState({}, "", "/m/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Inicia sesión en Union Ground", level: 1 }, { timeout: 5000 })).toBeInTheDocument();
    await settle();
    await waitFor(() => expect(document.title).toBe("Inicia sesión | Union Ground"));
  });

  it("names the landing, the linked sign-in page, and the landing again on return", async () => {
    window.history.replaceState({}, "", "/");
    const landing = render(<App />);
    const link = (await screen.findAllByRole("link", { name: "Worker sign in" }, { timeout: 5000 }))[0];
    const landingTitle = document.title;
    expect(landingTitle).not.toMatch(/Sign in|Member workspace/);
    expect(link).toHaveAttribute("href", "/m");
    landing.unmount();

    window.history.replaceState({}, "", link.getAttribute("href"));
    const signIn = render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 }, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Sign in | Union Ground"));
    expect(screen.getByRole("link", { name: "Union Ground home" })).toHaveAttribute("href", "/");
    signIn.unmount();

    window.history.replaceState({}, "", "/");
    render(<App />);
    await waitFor(() => expect(document.title).toBe(landingTitle));
  });
});
