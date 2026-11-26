import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletionCompletionCopy } from "../src/lib/accountDeletionCompletion.js";
import { t } from "../src/lib/i18n.js";

// BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016: the deletion
// dialog asks a member with no second factor for their password and sends it
// with the request; a member with a factor keeps the two-step guidance. The
// App harness is the one in membership-card-purge-boundary.test.jsx; the last
// block covers BUG-UG-SELF-DELETION-ERROR-BOUNDARY-20261016.

const CARD_LINEAGE = "10000000-0000-4000-8000-000000000001";
const authStorageKey = "test-auth-key";

const session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: CARD_LINEAGE }))}.sig`,
  refresh_token: "test-refresh-token",
  user: { id: "member-1", email: "member@example.test", app_metadata: { roles: ["member"] }, user_metadata: {} },
};

const stubs = vi.hoisted(() => ({
  loadShell: vi.fn(),
  loadRoute: vi.fn(),
  requestAccountDeletion: vi.fn(),
  clearSession: vi.fn(),
  purgeSensitiveEntries: vi.fn(),
  authChanged: null,
  signOut: vi.fn().mockResolvedValue({ error: null }),
}));

const supabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn(callback => {
      stubs.authChanged = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
    signOut: stubs.signOut,
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
  clearCapturedAppSessionLocally: stubs.clearSession,
  createCapturedAppSessionRpcClient: vi.fn(),
  verifyCapturedAppSession: vi.fn(),
  hasAppBackend: true,
  appSupabase: supabase,
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
  loadSnapshot: vi.fn().mockResolvedValue(null),
  saveSnapshot: vi.fn().mockResolvedValue(undefined),
  pendingCount: vi.fn().mockResolvedValue(0),
  replayQueue: vi.fn().mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false }),
  deleteSnapshot: vi.fn().mockResolvedValue(undefined),
  purgeSensitiveEntries: stubs.purgeSensitiveEntries,
}));

vi.stubEnv("MODE", "production");
const [{ App }, { fallbackData }] = await Promise.all([
  import("../src/App.jsx"),
  import("./fixtures/retired-pre-bot/src/data/fallback.js"),
]);

const member = {
  ...fallbackData.member,
  id: session.user.id,
  organizationId: "org",
  chapterId: "chapter",
  membershipStatus: "active",
};
// Union Ground has no membership card (D5), so only the session is seeded.
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
  stubs.clearSession.mockReset().mockResolvedValue(true);
  stubs.purgeSensitiveEntries.mockReset().mockResolvedValue(undefined);
});

async function openDeletion() {
  seedSession();
  // Union Ground's campaign workspace, with its Data rights tab, lives at
  // /m/organize/organize; the bare /m/organize is the Organize plane.
  window.history.replaceState({}, "", "/m/organize/organize");
  render(<App />);
  fireEvent.click((await screen.findAllByRole("link", { name: "Data rights" }, { timeout: 5000 }))[0]);
  fireEvent.click((await screen.findAllByRole("button", { name: "Delete my account" }))[0]);
  fireEvent.change(await screen.findByLabelText("Type DELETE MY ACCOUNT to confirm"), { target: { value: "DELETE MY ACCOUNT" } });
}
const submit = () => act(async () => { fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" })); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  session.user.factors = undefined;
});

describe("deletion re-authentication for a member without two-step sign-in", () => {
  it("asks for the password, sends it with the request and reaches the completion screen", async () => {
    await openDeletion();
    expect(screen.getByText("For security, enter your password to confirm it's you.")).toBeInTheDocument();
    expect(screen.queryByText(/must have completed two-step verification/)).toBeNull();
    const field = screen.getByLabelText("Your password");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "current-password");
    fireEvent.change(field, { target: { value: "member password 1" } });
    await submit();
    expect(stubs.requestAccountDeletion).toHaveBeenCalledWith(expect.anything(), "DELETE MY ACCOUNT", undefined, undefined, { password: "member password 1" });
    expect(await screen.findByRole("heading", { name: deletionCompletionCopy.en.title })).toBeInTheDocument();
  });

  it("names a wrong password and clears the field instead of telling the member to sign out", async () => {
    stubs.requestAccountDeletion.mockRejectedValueOnce(Object.assign(new Error("reauth-failed"), { code: "reauth-failed" }));
    await openDeletion();
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "wrong password 1" } });
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("That password didn't match. Check it and try again.");
    expect(screen.getByLabelText("Your password")).toHaveValue("");
    expect(screen.queryByText(/Sign out, then try to sign in again/)).toBeNull();
  });

  it("tells a passwordless refusal to enter the password, not to set up two-step", async () => {
    stubs.requestAccountDeletion.mockRejectedValueOnce(Object.assign(new Error("not-permitted"), { code: "not-permitted" }));
    await openDeletion();
    await submit();
    expect(stubs.requestAccountDeletion).toHaveBeenCalledWith(expect.anything(), "DELETE MY ACCOUNT");
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't confirm it's you. Enter your password and try again.");
  });

  // Union Ground signs in with email and password only (Codex P2 on #12),
  // so no deletion message sends a worker to a provider or passkey sign-in.
  it("names only the password flow in both languages", () => {
    expect(t("es", "hub.lifecycle.deleteNotPermittedPassword")).toBe("No pudimos confirmar que eres tú. Escribe tu contraseña e inténtalo de nuevo.");
    for (const lang of ["en", "es"]) {
      for (const key of ["deletePasswordIntro", "deleteReauthFailed", "deleteTryLater", "deleteNotPermittedPassword"]) {
        expect(t(lang, `hub.lifecycle.${key}`)).not.toMatch(/Apple|Google|passkey|llave de acceso/);
      }
    }
  });

  it("keeps the two-step rule and its specific guidance for a member with a verified factor", async () => {
    session.user.factors = [{ id: "f", factor_type: "totp", status: "verified" }];
    stubs.requestAccountDeletion.mockRejectedValueOnce(Object.assign(new Error("not-permitted"), { code: "not-permitted" }));
    await openDeletion();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    expect(screen.getByText(/must have completed two-step verification/)).toBeInTheDocument();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Sign out, sign in again with your two-step code, then delete your account within 10 minutes./);
  });
});

describe("self-deletion completion when effects flush after the render (real browser timing)", () => {
  // BUG-UG-SELF-DELETION-ERROR-BOUNDARY-20261016: act() flushes
  // passive effects synchronously, which hid the crash. Driving the click
  // outside act lets the member-loader effect scheduled by the deletion's
  // session-generation render run after cleanup has already cleared
  // sessionRef, exactly as in a browser.
  it("shows the confirmation instead of throwing from the member-loader effect", async () => {
    const errors = [];
    const onError = (event) => { errors.push(event.error || event.message); event.preventDefault?.(); };
    window.addEventListener("error", onError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // The browser's IndexedDB purge settles after the completion render has
    // committed but before React flushes that render's passive effects.
    stubs.purgeSensitiveEntries.mockImplementationOnce(() => new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.getElementById("account-deletion-title")) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }));
    try {
      await openDeletion();
      fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "member password 1" } });
      const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        screen.getByRole("button", { name: "Permanently delete my account" }).click();
        expect(await screen.findByRole("heading", { name: deletionCompletionCopy.en.title }, { timeout: 3000 })).toBeInTheDocument();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
      }
      expect(errors.map(String).filter((message) => /reading 'user'/.test(message))).toEqual([]);
      expect(consoleError.mock.calls.flat().map(String).filter((message) => /reading 'user'/.test(message))).toEqual([]);
      expect(screen.getByRole("heading", { name: deletionCompletionCopy.en.title })).toBeInTheDocument();
    } finally {
      window.removeEventListener("error", onError);
      consoleError.mockRestore();
    }
  });
});
