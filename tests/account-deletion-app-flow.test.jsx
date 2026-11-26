import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletionCompletionCopy } from "../src/lib/accountDeletionCompletion.js";

// Account deletion driven through the authenticated App UI: the completion
// screen waits for local cleanup, an ambiguous or refused request never claims
// deletion, and a replacement login survives the departing account's purge.
// (This file once also covered the membership card's saved copy; Union
// Ground has no membership card, so no card cache exists to purge.)

const SESSION_LINEAGE = "10000000-0000-4000-8000-000000000001";
const authStorageKey = "test-auth-key";

const session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: SESSION_LINEAGE }))}.sig`,
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
function seedSession() {
  localStorage.setItem(authStorageKey, JSON.stringify(session));
  expect(JSON.parse(localStorage.getItem(authStorageKey)).user.id).toBe(session.user.id);
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

// Union Ground's bare /m/organize is the Organize plane; the campaign
// workspace (with its Data rights tab) lives at /m/organize/organize.
async function submitDeletion() {
  seedSession();
  window.history.replaceState({}, "", "/m/organize/organize");
  render(<App />);
  fireEvent.click((await screen.findAllByRole("link", { name: "Data rights" }, { timeout: 5000 }))[0]);
  fireEvent.click((await screen.findAllByRole("button", { name: "Delete my account" }))[0]);
  fireEvent.change(await screen.findByLabelText("Type DELETE MY ACCOUNT to confirm"), { target: { value: "DELETE MY ACCOUNT" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" })); });
}

describe("App deletion completion through the authenticated UI", () => {
  it.each([true, false])("holds completion until local cleanup and acknowledges it; audited=%s", async audited => {
    stubs.requestAccountDeletion.mockResolvedValue({ deleted: true, audited });
    let finish;
    stubs.clearSession.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await submitDeletion();
    expect(await screen.findByRole("heading", { name: deletionCompletionCopy.en.title })).toHaveFocus();
    expect(screen.getByRole("button", { name: deletionCompletionCopy.en.continue })).toBeDisabled();
    expect(screen.getByText(audited ? deletionCompletionCopy.en.body : deletionCompletionCopy.en.pending)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "Permanently delete my account" })).toBeNull();
    expect(stubs.clearSession).toHaveBeenCalledWith(session, { explicitSignOut: true });
    await act(async () => finish(true));
    fireEvent.click(await screen.findByRole("button", { name: deletionCompletionCopy.en.continue }));
    expect(await screen.findByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(stubs.requestAccountDeletion).toHaveBeenCalledOnce();
  });

  it("shows an uncertain outcome without claiming deletion after a transport ambiguity", async () => {
    stubs.requestAccountDeletion.mockRejectedValueOnce(Object.assign(new Error("unknown"), { code: "account-delete-indeterminate" }));
    await submitDeletion();
    expect(await screen.findByRole("heading", { name: deletionCompletionCopy.en.uncertainTitle })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(deletionCompletionCopy.en.uncertainBody);
    expect(screen.queryByRole("heading", { name: deletionCompletionCopy.en.title })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: deletionCompletionCopy.en.continue }));
    expect(await screen.findByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
  });

  it("keeps a definite refusal in the deletion dialog without clearing the account", async () => {
    stubs.requestAccountDeletion.mockRejectedValueOnce(Object.assign(new Error("not-permitted"), { code: "not-permitted" }));
    await submitDeletion();
    expect(await screen.findByRole("button", { name: "Permanently delete my account" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: deletionCompletionCopy.en.title })).toBeNull();
    // A refusal starts no local cleanup at all: neither the sensitive outbox
    // purge nor the session clear runs.
    expect(stubs.purgeSensitiveEntries).not.toHaveBeenCalled();
    expect(stubs.clearSession).not.toHaveBeenCalled();
  });

  it("retries a failed outbox purge locally while retaining the completed deletion", async () => {
    stubs.purgeSensitiveEntries.mockRejectedValueOnce(new Error("storage unavailable"));
    await submitDeletion();
    const retry = await screen.findByRole("button", { name: deletionCompletionCopy.en.retry });
    expect(screen.getByRole("alert")).toHaveTextContent(deletionCompletionCopy.en.cleanupFailed);
    expect(stubs.clearSession).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(retry));
    expect(await screen.findByRole("button", { name: deletionCompletionCopy.en.continue })).toBeEnabled();
    expect(stubs.purgeSensitiveEntries).toHaveBeenCalledTimes(2);
    expect(stubs.clearSession).toHaveBeenCalledOnce();
    expect(stubs.requestAccountDeletion).toHaveBeenCalledOnce();
  });

  it("retains confirmed completion when SIGNED_OUT precedes the deletion response", async () => {
    stubs.requestAccountDeletion.mockImplementationOnce(async () => {
      stubs.authChanged("SIGNED_OUT", null);
      return { deleted: true, audited: true };
    });
    await submitDeletion();
    expect(await screen.findByRole("heading", { name: deletionCompletionCopy.en.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: deletionCompletionCopy.en.continue })).toBeEnabled();
    expect(stubs.clearSession).toHaveBeenCalledWith(session, { explicitSignOut: true });
  });

  it("preserves a replacement login while the departing account's purge is pending", async () => {
    let finish;
    stubs.purgeSensitiveEntries.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await submitDeletion();
    expect(await screen.findByRole("heading", { name: deletionCompletionCopy.en.title })).toBeInTheDocument();
    const replacement = { ...session, user: { ...session.user, id: "replacement-member" }, access_token: `header.${btoa(JSON.stringify({ session_id: "10000000-0000-4000-8000-000000000002" }))}.sig` };
    supabase.auth.getSession.mockResolvedValue({ data: { session: replacement }, error: null });
    localStorage.setItem(authStorageKey, JSON.stringify(replacement));
    await act(async () => stubs.authChanged("SIGNED_IN", replacement));
    await act(async () => finish());
    await settle();
    expect(screen.queryByRole("heading", { name: deletionCompletionCopy.en.title })).toBeNull();
    expect(screen.queryByRole("button", { name: deletionCompletionCopy.en.retry })).toBeNull();
    expect(stubs.clearSession).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(authStorageKey)).user.id).toBe(replacement.user.id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});
