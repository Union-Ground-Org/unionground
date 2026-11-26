import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Balanced-paren extraction, because one of the arguments is a ternary of two
// tr() calls: a `[^;]*` regex either truncates it or swallows the next
// statement.
function setDataErrorArguments(source) {
  const token = "setDataError(";
  const args = [];
  let index = source.indexOf(token);
  while (index !== -1) {
    let depth = 1;
    let cursor = index + token.length;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "(") depth += 1;
      else if (source[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    args.push(source.slice(index + token.length, cursor - 1));
    index = source.indexOf(token, cursor);
  }
  return args;
}

const stubs = vi.hoisted(() => ({
  loadShell: vi.fn(),
  loadRoute: vi.fn(),
  pendingCount: vi.fn(),
  replayQueue: vi.fn(),
  saveRightsProgress: vi.fn(),
  captureSanitizedDiagnostic: vi.fn(() => true),
  outboxStore: null,
}));

const session = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  user: {
    id: "member-1",
    email: "member@example.test",
    app_metadata: { roles: ["member"] },
    user_metadata: {},
  },
};

const supabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
        data: { currentLevel: "aal1", nextLevel: "aal1" },
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
  createCapturedAppSessionRpcClient: vi.fn(),
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
    createOutboxStore: () => stubs.outboxStore ?? {},
    pendingCount: stubs.pendingCount,
    replayQueue: stubs.replayQueue,
  };
});

vi.stubEnv("MODE", "production");
const [{ App }, { fallbackData }] = await Promise.all([
  import("../src/App.jsx"),
  import("./fixtures/retired-pre-bot/src/data/fallback.js"),
]);
// Fake retry clocks below must not expire the unrelated lazy-chunk deadline.
await import("../src/views/RightsView.jsx");

// "/" is the public Learn page for everyone in Union Ground; the signed-in
// workspace opens at /m.
beforeEach(() => {
  window.history.replaceState({}, "", "/m");
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
  stubs.outboxStore = null;
});

describe("App boot recovery without a saved copy", () => {
  // BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111:
  // a failed boot never paints a saved copy (it may belong to a chapter the
  // member has since left). An offline device is told Home needs a
  // connection; the reconnect path then loads fresh data.
  it("an offline boot shows the needs-a-connection screen and no saved copy", async () => {
    window.history.replaceState({}, "", "/m");
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    stubs.loadShell.mockRejectedValue(new TypeError("Failed to fetch"));
    stubs.pendingCount.mockResolvedValue(0);
    stubs.replayQueue.mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false });
    try {
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
      expect(screen.getByText(/Home needs a connection to show your campaign's latest information/)).toBeInTheDocument();
      expect(screen.queryByText(/Showing your saved copy/)).toBeNull();
      expect(document.querySelector("#main-content")).toBeNull();
      expect(stubs.loadRoute).not.toHaveBeenCalled();
    } finally {
      onLine.mockRestore();
    }
  });

  it("a server failure on an online device keeps the general copy, not the needs-a-connection text", async () => {
    stubs.loadShell.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Check your connection, then try again.")).toBeInTheDocument();
    expect(screen.queryByText(/Home needs a connection/)).toBeNull();
  });

  it("renders AppLoadingScreen while an authenticated session has no data yet", async () => {
    stubs.loadShell.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading Union Ground");
    expect(document.querySelector("#main-content")).toBeNull();
    expect(document.querySelector(".data-error")).toBeNull();
  });

  it("shows the data-error retry card when loadShell settles without data", async () => {
    stubs.loadShell.mockResolvedValue(undefined);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
    expect(document.querySelector("#main-content")).toBeNull();
  });

  // BUG-UG-LANDING-MEMBER-DATA-LOAD-FAILED-20261003: a boot load that
  // failed on a busy server stayed on this card until the member signed out
  // and in. The card now retries on its own and the page recovers.
  it("recovers from a failed boot load on its own, without a new sign-in", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/m");
    const member = { ...fallbackData, member: { ...fallbackData.member, id: session.user.id } };
    stubs.loadShell.mockRejectedValue(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
    stubs.loadRoute
      .mockRejectedValueOnce(Object.assign(new Error("still busy"), { code: "57014" }))
      .mockResolvedValue(member);
    render(<App />);
    await act(async () => {
      for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Union Ground will keep trying for a couple of minutes.")).toBeInTheDocument();
    expect(stubs.loadRoute).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(5_001));
    expect(stubs.loadRoute).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(15_001));
    expect(stubs.loadRoute.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull();
    expect(stubs.loadShell).toHaveBeenCalledTimes(1);
  });

  it("stops retrying on its own after a few spaced attempts", async () => {
    vi.useFakeTimers();
    stubs.loadShell.mockRejectedValue(new Error("server error"));
    stubs.loadRoute.mockRejectedValue(new Error("server error"));
    render(<App />);
    await act(async () => {
      for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    });
    for (const step of [5_001, 15_001, 45_001, 90_001, 5 * 60_000]) {
      await act(() => vi.advanceTimersByTimeAsync(step));
    }
    expect(stubs.loadRoute).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
    expect(screen.queryByText("Union Ground will keep trying for a couple of minutes.")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps the retry budget while offline and resumes when the device reconnects", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/m");
    const member = { ...fallbackData, member: { ...fallbackData.member, id: session.user.id } };
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    stubs.loadShell.mockRejectedValue(new Error("server error"));
    stubs.loadRoute.mockResolvedValue(member);
    render(<App />);
    await act(async () => {
      for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    });
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(stubs.loadRoute).not.toHaveBeenCalled();
    expect(screen.getByText("Union Ground will keep trying for a couple of minutes.")).toBeInTheDocument();

    onLine.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(() => vi.advanceTimersByTimeAsync(5_001));
    expect(stubs.loadRoute).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull();
    onLine.mockRestore();
  });

  // #9470 (W2-5): Try again shows it is working, and a try that fails again says so with its count.
  it("shows Try again working, then a counted line when the retry fails again", async () => {
    stubs.loadShell.mockRejectedValue(new Error("server error"));
    let failRoute;
    stubs.loadRoute.mockImplementation(() => new Promise((_resolve, reject) => { failRoute = reject; }));
    render(<App />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByText(/Tried again/)).toBeNull();
    await act(async () => { retry.click(); });
    expect(screen.getByRole("button", { name: "Trying again…" })).toHaveAttribute("aria-busy", "true");
    await act(async () => { failRoute(Object.assign(new Error("Request timed out"), { name: "TimeoutError" })); });
    expect(await screen.findByRole("button", { name: "Try again" })).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("Tried again (1): worker data is still unavailable.")).toBeInTheDocument();
    expect(screen.getByText("The connection took too long. Try again.")).toBeInTheDocument();
  });

  // #9470 review: a try still running when the sign-in changes leaves no count on the next sign-in's card.
  it("drops a Try again that outlives a new sign-in", async () => {
    stubs.loadShell.mockRejectedValue(new Error("server error"));
    let failRoute;
    stubs.loadRoute.mockImplementation(() => new Promise((_resolve, reject) => { failRoute = reject; }));
    render(<App />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    await act(async () => { retry.click(); });
    expect(screen.getByRole("button", { name: "Trying again…" })).toBeInTheDocument();
    const oldTry = failRoute;
    const authChanged = supabase.auth.onAuthStateChange.mock.calls.at(-1)[0];
    await act(async () => { authChanged("SIGNED_IN", { ...session, access_token: "new-login-token", refresh_token: "new-login-refresh" }); });
    expect(await screen.findByRole("button", { name: "Try again" })).not.toHaveAttribute("aria-busy");
    await act(async () => { oldTry(Object.assign(new Error("Request timed out"), { name: "TimeoutError" })); });
    expect(screen.queryByText(/Tried again/)).toBeNull();
    expect(screen.queryByText("The connection took too long. Try again.")).toBeNull();
  });

  it("clears the count when a later Try again loads the data", async () => {
    window.history.replaceState({}, "", "/m");
    stubs.loadShell.mockRejectedValue(new Error("server error"));
    stubs.loadRoute.mockRejectedValueOnce(new Error("server error"))
      .mockResolvedValue({ ...fallbackData, member: { ...fallbackData.member, id: session.user.id } });
    render(<App />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    await act(async () => { retry.click(); });
    expect(await screen.findByText("Tried again (1): worker data is still unavailable.")).toBeInTheDocument();
    await act(async () => { screen.getByRole("button", { name: "Try again" }).click(); });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Campaign data is unavailable" })).toBeNull());
    expect(screen.queryByText(/Tried again/)).toBeNull();
  });

  it("shows translated load-failed copy instead of the driver message", async () => {
    const driver = "permission denied for table member_profiles";
    stubs.loadShell.mockRejectedValue(new Error(driver));
    render(<App />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Campaign data is unavailable" })).toBeInTheDocument();
    // Plain words, never the bare "Load failed" (BUG-UG-SHELL-ERROR-STATES-BARE-LOAD-FAILED-20261106).
    expect(screen.getByText("Check your connection, then try again.")).toBeInTheDocument();
    expect(screen.queryByText("Load failed")).not.toBeInTheDocument();
    expect(document.querySelector(".data-error--boot .loading-screen__brand")).not.toBeNull();
    expect(screen.queryByText(driver)).not.toBeInTheDocument();
  });

  it("keeps a saved write's failed refresh out of the page copy and in the sanitized diagnostic", async () => {
    // mutate() used to assign the driver's own sentence to dataError when the
    // write LANDED and only the follow-up reload failed, which is the string the
    // data-error card renders as page copy. The member now gets the translated
    // reload-failed copy and the raw failure goes to the sanitized diagnostic
    // channel #2040 added for the authenticated shell load.
    const driver = "permission denied for table member_rights_progress";
    const memberData = { ...fallbackData, member: { ...fallbackData.member, id: session.user.id } };
    stubs.loadShell.mockResolvedValue(memberData);
    stubs.loadRoute.mockResolvedValue(memberData);
    stubs.pendingCount.mockResolvedValue(0);
    stubs.replayQueue.mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false });
    stubs.saveRightsProgress.mockResolvedValue({});
    window.history.replaceState({}, "", "/m/rights");

    render(<App />);
    const openGuide = await screen.findByRole("button", { name: /Start the walkthrough|Continue/ });
    await act(async () => { openGuide.click(); });
    const step = document.querySelector(".learn-step");
    expect(step).toBeTruthy();

    const refreshFailure = Object.assign(new Error(driver), { code: "42501" });
    stubs.loadRoute.mockRejectedValue(refreshFailure);
    await act(async () => {
      step.click();
      for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    });

    expect(stubs.saveRightsProgress).toHaveBeenCalledTimes(1);
    // The write is committed, so the member keeps the page and is told to
    // refresh — in their own language, with no driver sentence anywhere on it.
    expect(await screen.findByText("Progress saved. Refresh to load the latest data.")).toBeInTheDocument();
    expect(screen.queryByText(driver)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(driver);
    expect(document.body.textContent).not.toContain("permission denied");

    expect(stubs.captureSanitizedDiagnostic).toHaveBeenCalledWith({
      kind: "member_mutation_refresh_failure",
      code: "42501",
      name: "Error",
    });
    // The channel is sanitized: the driver's message text never enters it.
    expect(JSON.stringify(stubs.captureSanitizedDiagnostic.mock.calls)).not.toContain("permission denied");
  });

  it("never hands a raw driver message to the member-facing data error", () => {
    // The behavioural case above cannot see this repair: the data-error card
    // renders only under `dataError && !data` (src/App.jsx) or on the SAMPLE
    // no-session path, and after a successful write `data` is present — so with
    // the buggy line restored the raw string sits in state, unrendered, and
    // every body-text assertion still passes. This guard reads the source
    // instead, comments stripped the way tests/i18n-coverage.test.jsx does it,
    // and fails the moment any call site assigns the caught error's own words.
    const source = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const args = setDataErrorArguments(source);
    expect(args.length).toBeGreaterThanOrEqual(8);
    for (const argument of args) {
      expect(argument, `setDataError(${argument})`).not.toMatch(/\.message\b/);
    }
    // …and the mutate() refresh catch specifically renders the translated copy
    // and routes the failure to the sanitized channel.
    const afterRefresh = source.slice(source.indexOf("await memberOperation.wait(refresh(actingSession, affectedResources));"));
    const refreshCatch = afterRefresh.slice(0, afterRefresh.indexOf('setNotice(tr("toast.refreshHint"'));
    expect(refreshCatch).toContain('captureSanitizedDiagnostic({ kind: "member_mutation_refresh_failure"');
    expect(refreshCatch).toContain('tr("error.requestTimedOut")');
    expect(refreshCatch).toContain('tr("toast.reloadFailed")');
  });

  it("shows the timeout copy when loadShell rejects with TimeoutError", async () => {
    const error = new Error("Request timed out");
    error.name = "TimeoutError";
    stubs.loadShell.mockRejectedValue(error);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText("The connection took too long. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Request timed out")).not.toBeInTheDocument();
  });
});

// BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111
// (record #8310). The member switched Cedar -> Harbor away from Home. Copies
// an older build left on this device still hold Cedar: the session-storage
// Home slice and the IndexedDB saved copy. Neither may ever reach the screen,
// before the shell resolves, after it, or when the boot fails offline.
describe("Home paints only fresh data after a campaign switch", () => {
  const LEGACY_SLICE_KEY = "ug-member-home-slice:v1";
  const chapterData = (chapterId, chapterName, eventTitle) => ({
    ...fallbackData,
    member: { ...fallbackData.member, id: session.user.id, chapterId, chapterName },
    events: fallbackData.events.map((event, index) => ({
      ...event, chapterId, chapterName, title: index === 0 ? eventTitle : event.title,
    })),
  });
  const cedar = chapterData("cedar", "Cedar Valley Campaign", "Cedar Valley picnic");
  const harbor = chapterData("harbor", "Harbor Point Campaign", "Harbor Point rally");
  const plantCedarCopies = async () => {
    sessionStorage.setItem(LEGACY_SLICE_KEY, JSON.stringify({ userId: session.user.id, projection: cedar, savedAt: 1 }));
    const { createMemoryStore, sessionStamp } = await vi.importActual("../src/lib/outbox.js");
    const store = createMemoryStore();
    // Stamped by this device boot under a later generation, as the old writer
    // stamped the live session's copy, so no departure sweep treats it as residue.
    await store.putSnapshot({ userId: session.user.id, savedAt: 1, data: cedar, ...sessionStamp(99) });
    stubs.outboxStore = store;
    return store;
  };
  const showsCedar = () => /Cedar Valley/.test(document.body.textContent);
  // Records a Cedar paint however briefly it lasts: the old retained Home
  // rendered only once its lazy view loaded, after any immediate check.
  const watchForCedar = () => {
    const seen = { cedar: false };
    const observer = new MutationObserver(() => { if (showsCedar()) seen.cedar = true; });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return { seen, stop: () => observer.disconnect() };
  };
  // Long enough for a lazy Home view to load and paint a retained copy.
  const settle = () => act(() => new Promise((resolve) => { setTimeout(resolve, 400); }));

  it("waits for the fresh Harbor shell on a cold Home load and never shows the Cedar copies", async () => {
    window.history.replaceState({}, "", "/m");
    const store = await plantCedarCopies();
    let resolveShell;
    stubs.loadShell.mockReturnValue(new Promise((resolve) => { resolveShell = resolve; }));
    let resolveRoute;
    stubs.loadRoute.mockReturnValue(new Promise((resolve) => { resolveRoute = resolve; }));
    stubs.pendingCount.mockResolvedValue(0);
    stubs.replayQueue.mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false });

    const watch = watchForCedar();
    try {
      render(<App />);
      expect(await screen.findByRole("status")).toHaveTextContent("Loading Union Ground");
      await settle();
      expect(showsCedar()).toBe(false);
      await waitFor(() => expect(sessionStorage.getItem(LEGACY_SLICE_KEY)).toBeNull());
      await waitFor(async () => expect(await store.getSnapshot(session.user.id)).toBeNull());

      await act(async () => { resolveShell(harbor); });
      // The shell committed and the Home route read is still in flight: no
      // retained value fills its empty keys.
      await settle();
      expect(showsCedar()).toBe(false);
      await act(async () => { resolveRoute(harbor); });
      await waitFor(() => expect(document.body.textContent).toMatch(/Harbor Point/));
      expect(watch.seen.cedar).toBe(false);
    } finally {
      watch.stop();
    }
  });

  it("shows the needs-a-connection screen, not the Cedar saved copy, when the boot fails offline", async () => {
    window.history.replaceState({}, "", "/m");
    await plantCedarCopies();
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    stubs.loadShell.mockRejectedValue(new TypeError("Failed to fetch"));
    stubs.pendingCount.mockResolvedValue(0);
    stubs.replayQueue.mockResolvedValue({ replayed: 0, failed: 0, expired: 0, halted: false });
    const watch = watchForCedar();
    try {
      render(<App />);
      expect(await screen.findByText(/Home needs a connection/)).toBeInTheDocument();
      await settle();
      expect(watch.seen.cedar).toBe(false);
      expect(document.querySelector("#main-content")).toBeNull();
    } finally {
      watch.stop();
      onLine.mockRestore();
    }
  });
});
