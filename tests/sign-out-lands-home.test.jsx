import { createExactSessionStorage } from "../src/lib/exactSessionStorage.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";

// BUG-UG-SIGN-OUT-KEEPS-THE-LAST-PAGE-ADDRESS-20261006: after an
// explicit sign-out the address bar stayed on the last page (/m/settings) and
// the sign-in screen promised to return there. The same App harness as
// account-deletion-app-flow.test.jsx, with the local session clear
// reporting success so the signed-out branch actually renders.

const SESSION_LINEAGE = "10000000-0000-4000-8000-000000000001";
const authStorageKey = "test-auth-key";

const session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: SESSION_LINEAGE }))}.sig`,
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
const [{ App }, { fallbackData }] = await Promise.all([
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
function seedSession() {
  localStorage.setItem(authStorageKey, JSON.stringify(session));
  // Guard the guard: every later assertion is vacuous if the seed never landed.
  expect(JSON.parse(localStorage.getItem(authStorageKey)).user.id).toBe(session.user.id);
}

async function settle() {
  await act(async () => { for (let pass = 0; pass < 20; pass += 1) await Promise.resolve(); });
}

async function goBack() {
  await act(async () => {
    const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await popped;
  });
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // The public front door at "/" never reads the session, so a queued one-shot
  // restore result from an earlier test would otherwise leak into this one.
  supabase.auth.getSession.mockReset();
  supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
  supabase.rpc.mockImplementation(async (name) => ({ data: name === "get_my_legal_acceptance_state"
    ? { versions: currentLegalVersions() }
    : name === "list_my_sessions" ? [{ handle: "a".repeat(64), current: true, deviceLabel: "windows_computer", browserLabel: "chrome" }] : null, error: null }));
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

describe("explicit sign-out", () => {
  it("finishes global sign-out on the sign-in screen instead of a member-data error", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings/sessions");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm sign out everywhere" }));
    expect(await screen.findByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    expect(supabase.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, "global");
    expect(screen.queryByRole("heading", { name: "Member data is unavailable" })).toBeNull();
    expect(window.location.pathname).toBe("/");
  });
  it.each([null, session, "returned-error", "rejected-promise"])("an explicit sign-out during initial restore ends the visit despite restore %s", async (restored) => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings?section=privacy#account");
    let resolveRestore;
    let rejectRestore;
    supabase.auth.getSession.mockReturnValueOnce(new Promise((resolve, reject) => {
      resolveRestore = resolve;
      rejectRestore = reject;
    }));
    render(<App />);
    await settle();
    const writes = [];
    const adapter = createExactSessionStorage({
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => { const oldValue = localStorage.getItem(key); localStorage.setItem(key, value); writes.push({ key, oldValue, newValue: value }); },
      removeItem: (key) => localStorage.removeItem(key),
    });
    expect(await adapter.removeSessionIfMatches(authStorageKey, session, { explicitSignOut: true })).toBe(true);
    await act(async () => {
      for (const write of writes) window.dispatchEvent(new StorageEvent("storage", write));
    });
    // Explicit sign-out settles the loading screen immediately, even when the
    // fenced getSession request has not returned yet.
    expect(screen.getByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    await act(async () => {
      if (restored === "rejected-promise") rejectRestore(new Error("Restore failed"));
      else resolveRestore({
        data: { session: restored === "returned-error" ? null : restored },
        error: restored === "returned-error" ? new Error("Restore failed") : null,
      });
    });
    await settle();
    expect.soft(window.location.pathname + window.location.search + window.location.hash).toBe("/");
    expect.soft(sessionStorage.getItem(`${authStorageKey}.explicit-sign-out-visit`)).toBe("1");
    expect.soft(screen.queryByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    expect.soft(screen.queryByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeNull();
  });

  it.each(["expiry", "replacement"])("preserves the requested page during initial restore after %s", async (kind) => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings?section=privacy#account");
    let resolveRestore;
    supabase.auth.getSession.mockReturnValueOnce(new Promise((resolve) => { resolveRestore = resolve; }));
    render(<App />);
    await settle();
    const writes = [];
    const adapter = createExactSessionStorage({
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => { const oldValue = localStorage.getItem(key); localStorage.setItem(key, value); writes.push({ key, oldValue, newValue: value }); },
      removeItem: (key) => localStorage.removeItem(key),
    });
    expect(await adapter.removeSessionIfMatches(authStorageKey, session, { explicitSignOut: kind === "replacement" })).toBe(true);
    const replacement = { ...session, access_token: `header.${btoa(JSON.stringify({ session_id: "10000000-0000-4000-8000-000000000002" }))}.sig` };
    if (kind === "replacement") localStorage.setItem(authStorageKey, JSON.stringify(replacement));
    await act(async () => {
      for (const write of writes) window.dispatchEvent(new StorageEvent("storage", write));
      resolveRestore({ data: { session: kind === "replacement" ? replacement : null }, error: null });
    });
    await settle();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/m/settings?section=privacy#account");
    expect(sessionStorage.getItem(`${authStorageKey}.explicit-sign-out-visit`)).toBeNull();
    if (kind === "replacement") await screen.findByRole("button", { name: "Sign out" });
    else expect(screen.getByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeInTheDocument();
  });

  // BUG-UG-SIGNIN-SAYS-REQUESTED-PAGE-WAITING-20261018: the line is
  // honest only when a deeper page is waiting; bare /m asked for no page.
  it.each([
    ["/m", false],
    ["/m/", false],
    ["/m/messages", true],
  ])("at %s the requested-page line is shown: %s", async (path, shown) => {
    window.history.replaceState({}, "", path);
    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in to Union Ground" });
    await settle();
    const line = "Your requested page is waiting. Sign in and you’ll return there automatically.";
    if (shown) expect(screen.getByText(line)).toBeInTheDocument();
    else expect(screen.queryByText(line)).toBeNull();
  });

  it("normalizes an ended visit when Back restores a member document before popstate subscription", async () => {
    sessionStorage.setItem(`${authStorageKey}.explicit-sign-out-visit`, "1");
    window.history.replaceState({}, "", "/m/messages?thread=previous#message");
    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<App />);
    await screen.findByRole("heading", { name: "Sign in to Union Ground" });
    await settle();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
    expect(screen.queryByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeNull();
  });

  it.each(["before", "after"])("lands another tab at / when the explicit marker arrives %s its closure event", async (order) => {
    seedSession();
    window.history.replaceState({}, "", "/m/messages?thread=previous#message");
    window.history.pushState({}, "", "/m/settings");
    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });
    const closure = { key: `${authStorageKey}.closed-session.${SESSION_LINEAGE}`, newValue: "closed", oldValue: null };
    const explicit = { key: `${authStorageKey}.explicit-sign-out`, newValue: SESSION_LINEAGE, oldValue: null };
    // Actual remote storage already contains its committed fence when events arrive.
    localStorage.setItem(closure.key, "closed");
    for (const event of order === "before" ? [explicit, closure] : [closure, explicit]) {
      await act(async () => { window.dispatchEvent(new StorageEvent("storage", event)); });
      await settle();
    }
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
    expect(screen.queryByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeNull();
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    await goBack();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
  });

  it("does not reset a replacement login when an old explicit marker arrives late", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings");
    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });
    const replacement = { ...session, access_token: `header.${btoa(JSON.stringify({ session_id: "10000000-0000-4000-8000-000000000002" }))}.sig` };
    localStorage.setItem(authStorageKey, JSON.stringify(replacement));
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: `${authStorageKey}.explicit-sign-out`, newValue: SESSION_LINEAGE, oldValue: null,
      }));
    });
    await settle();
    expect(window.location.pathname).toBe("/m/settings");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("honors an explicit marker after auth has already reported the same session signed out", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings");
    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });
    localStorage.setItem(`${authStorageKey}.closed-session.${SESSION_LINEAGE}`, "closed");
    const notify = supabase.auth.onAuthStateChange.mock.calls.at(-1)[0];
    await act(async () => { notify("SIGNED_OUT", null); });
    await settle();
    expect(window.location.pathname).toBe("/m/settings");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: `${authStorageKey}.explicit-sign-out`, newValue: SESSION_LINEAGE, oldValue: null,
      }));
    });
    await settle();
    expect(window.location.pathname).toBe("/");
  });

  it("keeps earlier member history entries at / after explicit sign-out", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m");
    window.history.pushState({}, "", "/m/messages?thread=previous#message");
    window.history.pushState({}, "", "/m/settings");
    render(<App />);

    const signOut = await screen.findByRole("button", { name: "Sign out" });
    await act(async () => { fireEvent.click(signOut); });
    await settle();
    expect(window.location.pathname).toBe("/");

    for (let entry = 0; entry < 2; entry += 1) {
      await goBack();
      expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
      expect(screen.getByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
      expect(screen.queryByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeNull();
      expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    }
  });

  it("keeps earlier member history at / after reloading an explicitly signed-out visit", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/messages?thread=previous#message");
    window.history.pushState({}, "", "/m/settings");
    const mounted = render(<App />);
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    await act(async () => { fireEvent.click(signOut); });
    await settle();
    mounted.unmount();

    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<App />);
    await settle();
    // #6578 finding 93: the reloaded, explicitly signed-out tab opens on the
    // sign-in card, not the public landing page.
    expect(document.querySelector(".public-site")).toBeNull();
    expect(screen.getByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    await goBack();

    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
    expect(screen.getByRole("heading", { level: 1, name: /Organize first\./ })).toBeInTheDocument();
    expect(screen.queryByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeNull();
  });

  it("preserves Back and the requested-page note after session expiry and reload", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/messages?thread=resume#message");
    window.history.pushState({}, "", "/m/settings");
    const mounted = render(<App />);
    await screen.findByRole("button", { name: "Sign out" });

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: `${authStorageKey}.closed-session.${SESSION_LINEAGE}`, newValue: "closed", oldValue: null,
      }));
    });
    await settle();
    mounted.unmount();
    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<App />);
    await settle();
    await goBack();

    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/m/messages?thread=resume#message");
    expect(screen.getByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeInTheDocument();
  });

  it("allows member history again after a new sign-in", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/messages");
    window.history.pushState({}, "", "/m/settings");
    const mounted = render(<App />);
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    await act(async () => { fireEvent.click(signOut); });
    await settle();

    const signedIn = supabase.auth.onAuthStateChange.mock.calls.at(-1)[0];
    const nextSession = { ...session, access_token: `header.${btoa(JSON.stringify({ session_id: "10000000-0000-4000-8000-000000000002" }))}.sig` };
    await act(async () => { signedIn("SIGNED_IN", nextSession); });
    await settle();
    await goBack();

    expect(window.location.pathname).toBe("/m/messages");
    expect(screen.queryByRole("heading", { name: "Sign in to Union Ground" })).toBeNull();

    // The new visit must also survive reload without reviving the previous
    // visit's explicit sign-out decision when this session later expires.
    mounted.unmount();
    window.history.pushState({}, "", "/m/settings");
    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<App />);
    await settle();
    await goBack();
    expect(window.location.pathname).toBe("/m/messages");
    expect(screen.getByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeInTheDocument();
  });

  // BUG-UG-SIGN-IN-SCREEN-CARRIES-ANOTHER-PAGES-TAB-TITLE-20261122:
  // sign-out lands on the sign-in screen at /, and the head names that screen,
  // not the landing page the address alone would give.
  it("replaces the member page metadata with the sign-in screen's metadata", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings?section=privacy#account");
    render(<App />);

    const signOut = await screen.findByRole("button", { name: "Sign out" });
    // Signed in, the tab names the page and the worn role
    // (REQ-UG-NAV-LIGHT-IDENTITY-20261102); sign-out clears it below.
    await waitFor(() => expect(document.title).toMatch(/ · Worker \| Union Ground$/));
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    await act(async () => { fireEvent.click(signOut); });
    await settle();

    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
    expect(screen.getByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
    const title = "Sign in | Union Ground";
    const description = "Sign in to Union Ground with the email address and password from your invitation.";
    expect(document.title).toBe(title);
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
      expect(document.head.querySelector(selector).content).toBe(title);
    }
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
      expect(document.head.querySelector(selector).content).toBe(description);
    }
    expect(document.head.querySelector('meta[property="og:url"]')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]').content).toBe("noindex, nofollow, noarchive, noai, noimageai");
  });

  it("lands on the sign-in page at / with no return-to intent", async () => {
    seedSession();
    window.history.replaceState({}, "", "/m/settings");
    render(<App />);

    const signOut = await screen.findByRole("button", { name: "Sign out" });
    await act(async () => { fireEvent.click(signOut); });
    await settle();

    expect(window.location.pathname).toBe("/");
    expect((await screen.findAllByRole("button", { name: /^Sign in/ })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeNull();
  });

  it("leaves another tab's address and return-to alone when its session closes elsewhere", async () => {
    // Gate round 2 on #4112: the closed-session tombstone is also written on
    // session expiry, revocation and a new login, where resuming the
    // requested page is intended, so only the tab that clicked Sign out moves.
    seedSession();
    window.history.replaceState({}, "", "/m/settings");
    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });

    const key = `${authStorageKey}.closed-session.${SESSION_LINEAGE}`;
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: "closed", oldValue: null }));
    });
    await settle();

    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull());
    expect(window.location.pathname).toBe("/m/settings");
    expect(screen.getByText("Your requested page is waiting. Sign in and you’ll return there automatically.")).toBeInTheDocument();
  });
});
