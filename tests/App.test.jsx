import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, configure, fireEvent, getConfig, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App, applyBoardEvent, applyTaskConversionResult, demoSessionFor, localTaskRowWins, shouldShowConfigurationGate } from "../src/App.jsx";
import { AppErrorBoundary } from "../src/components/ErrorBoundary.jsx";
// The public pages are routed by src/AppRouter.jsx, the App that src/main.jsx mounts.
import { App as RoutedApp } from "../src/AppRouter.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { chapterTaskFromRow } from "../src/lib/memberApi.js";
import { t } from "../src/lib/i18n.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { choosePage, findPageMenuTrigger } from "./helpers/workspacePageMenu.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

// Most find* here await a lazy route chunk, and under host load the chunk can
// land after Testing Library's 1 s default (OPS-UG-TESTS-HOLD-UNDER-HOST-LOAD-20261030:
// four of 41 tests failed that way at load 50-74, a different set each run).
// tests/setup.js widens the default only under CI, so this file sets its own
// bound everywhere: the 8 s its explicit lazy-chunk waits already use. Only
// how long a wait may take changes; every query and assertion is as before.
const LAZY_CHUNK_WAIT_MS = 8_000;
let defaultAsyncUtilTimeout;

beforeAll(() => {
  defaultAsyncUtilTimeout = getConfig().asyncUtilTimeout;
  configure({ asyncUtilTimeout: LAZY_CHUNK_WAIT_MS });
});

afterAll(() => {
  configure({ asyncUtilTimeout: defaultAsyncUtilTimeout });
});

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("member app", () => {
  const openDirectoryCompass = () => fireEvent.click(
    [...document.querySelectorAll(".morehub-row")].find((row) => row.textContent.includes("Union Ground Guide")),
  );
  // Wave 2a (2026-07-28): TodayView is the prototype's Home. The greeting h1
  // carries a literal 👋 now, "Today's plan" is gone, and the page is driven
  // by the real open ballot (dark-green hero + orange CTA), the live rewards
  // chips, and the "Next 2 minutes" / "This week" quick rows.
  it("renders the prototype Home from the live fixture data", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    // The hero is the REAL open ballot, not seeded copy: its title and CTA
    // come from the same plan item the choice dialog submits.
    expect(screen.getByRole("heading", { name: /file the representation petition this month/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cast your vote" })).toBeInTheDocument();
    // Union Ground has no points economy: the chips are the worker's own
    // reports and local search, and no points ring, tier or "+N pts" appears
    // anywhere on Home. The quorum card reads the ballot's own quorum figures.
    const chips = document.querySelector(".home-chips");
    expect(within(chips).getByRole("button", { name: "My reports" })).toBeInTheDocument();
    expect(chips.textContent).not.toMatch(/\bpts\b|points/i);
    expect(document.querySelector(".home-ring, .home-row__pts")).toBeNull();
    expect(document.querySelector(".home-greet").textContent).not.toMatch(/\d+\s*pts\b/);
    expect(screen.getByRole("button", { name: /Campaign quorum/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Chapter quorum/ })).toBeNull();
    expect(screen.getByText("Next 2 minutes")).toBeInTheDocument();
    expect(screen.getByText("This week")).toBeInTheDocument();
  });

  // Every view but Today is its own chunk now, so the first assertion after a
  // navigation has to await the chunk. Once it has landed the rest of the
  // interactions in a test stay synchronous — the module cache is warm.
  //
  // Wave 2a: the Messages tab left the member bar, so the honest member path
  // is the one the design ships — More hub → "Message a steward". Wave 2b
  // The unified inbox keeps every backed message source in one chronological
  // feed. This test guards the hub entrance, honest filter counts, the full
  // announcement archive, and source-specific opening behavior.
  it("navigates to Messages through the More hub and operates the unified inbox", async () => {
    render(<App />);
    // The More/Settings entry lives in the drawer card's Account group now
    // (2026-08-07 chrome-free wave): open the drawer, then follow it.
    fireEvent.click(screen.getByRole("button", { name: "All features" }));
    // The pinned Settings shortcut shares the Account row's name (#9527); take the Account row.
    fireEvent.click(within(document.querySelector(".card-nav__panel--features")).getAllByRole("link", { name: "Settings" }).at(-1));
    choosePage(await findPageMenuTrigger(), "/m/settings/shortcuts");
    fireEvent.click(await screen.findByRole("button", { name: /Message a committee member/ }));
    // The Messages route mounts behind a lazy chunk, so the heading lands after
    // the shell's loading fallback; Testing Library's 1s findBy default is below
    // that on a contended runner.
    expect(await screen.findByRole("heading", { name: "Messages" }, { timeout: 8_000 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/messages");
    expect(screen.getByRole("heading", { name: "Latest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contacts 1 (pending)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Channels" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Direct" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Announcements" })).toBeInTheDocument();
    // Below the desktop split the inbox shows a page at a time
    // (BUG-UG-MESSAGES-INBOX-RENDERS-ALL-ITEMS-NARROW-20261106).
    expect(document.querySelectorAll(".inbox-row")).toHaveLength(20);
    expect(screen.getByText("Showing 1–20 of 27")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(document.querySelectorAll(".inbox-row")).toHaveLength(27);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".inbox-chip--person")).toHaveLength(3);
    expect(document.querySelectorAll(".inbox-chip--org")).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Announcements" }));
    expect(document.querySelectorAll(".inbox-row")).toHaveLength(20);
    // An announcement opens in place — the same dialog contract as before.
    fireEvent.click(screen.getByText("Campaign briefing 1"));
    const announcementDialog = await screen.findByRole("dialog");
    expect(announcementDialog).toHaveTextContent("Campaign briefing 1");
    fireEvent.click(within(announcementDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(announcementDialog).not.toBeInTheDocument());
    // A channel row hands off to the Organize hub thread (onOpenTopics).
    fireEvent.click(screen.getByRole("button", { name: "Channels" }));
    // BUG-UG-WEB-CHANNEL-FROM-MESSAGES-DOES-NOT-OPEN-THREAD-RECURRENCE-20261009:
    // the keyboard half of the acceptance. The row is a native, enabled button
    // that takes DOM focus, so Enter and Space ARE its activation in every
    // browser; jsdom does not synthesize the click a browser fires for that
    // activation, so the keydown is driven here and the activation click
    // follows it. Pointer and keyboard therefore reach the same handoff.
    //
    // The not-yet-loaded half of the same record — a handed-over channel the
    // loaded product spaces do not carry — is latched as a pending intent in
    // ProductHubView and resolved by the next snapshot that carries it or by
    // messagingApi.loadChannelLanding. Both resolutions are named regressions
    // in tests/channel-post-landing.test.jsx, because this suite runs on the
    // fixture snapshot: its messaging api carries no channel loader, and the
    // Messages channel list and the hub read the SAME product.spaces array, so
    // a channel row reachable here is loaded by construction.
    const channelRow = screen.getByText(/Overtime scheduling and notice/).closest("button");
    expect(channelRow.tagName).toBe("BUTTON");
    expect(channelRow).not.toBeDisabled();
    channelRow.focus();
    expect(channelRow).toHaveFocus();
    fireEvent.keyDown(channelRow, { key: "Enter", code: "Enter" });
    fireEvent.click(channelRow);
    expect(await screen.findByRole("heading", { name: "My campaign" }, { timeout: 8_000 })).toBeInTheDocument();
    // BUG-UG-WEB-CHANNEL-FROM-MESSAGES-DOES-NOT-OPEN-THREAD-20261003:
    // the hub normalises the address to its Topics tab, and that thread's
    // dialog must still be open afterwards.
    await waitFor(() => expect(window.location.pathname).toBe("/m/organize/organize"));
    const threadDialog = await screen.findByRole("dialog", { name: /Overtime scheduling and notice/ }, { timeout: 8_000 });
    expect(threadDialog).toBeVisible();
  }, 30_000);

  // Wave 2a note: the Preview guide moved into the demo chrome — its member
  // entry (the old Today grid-More button) retired with the prototype Home,
  // and the demo bar's Guide pill is its home now, matching the prototype's
  // own demo panel. The assistant surfaces remain reachable through the bar's
  // Compass button, which is what this pins.
  it("opens and closes the Compass assistant surfaces from the tab bar", async () => {
    render(<App />);
    openDirectoryCompass();
    expect(await screen.findByRole("dialog", { name: "Union Ground Guide" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
    expect(screen.getByRole("complementary", { name: "Conversation history" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByRole("complementary", { name: "Conversation history" })).not.toBeInTheDocument();
    // One close affordance (owner feedback, 2026-08-05): the minimize twin is
    // gone — X is the only way out and it fully closes the takeover.
    expect(screen.queryByRole("button", { name: "Minimize" })).not.toBeInTheDocument();
    // jsdom answers narrow, so this is the phone takeover: a real modal.
    expect(screen.getByRole("dialog", { name: "Union Ground Guide" }).getAttribute("aria-modal")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close and discard this draft" }));
    expect(screen.queryByRole("dialog", { name: "Union Ground Guide" })).not.toBeInTheDocument();
    // Escape is the keyboard way out of the takeover.
    openDirectoryCompass();
    expect(await screen.findByRole("dialog", { name: "Union Ground Guide" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Union Ground Guide" })).not.toBeInTheDocument();
  });

  it("renders the workload log in demo and switches its tabs", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/workload?demo=1");
    render(<App />);
    // Submit tab is the default; it's a member view so the phone chrome stays
    // (the persistent Home orb since the 2026-08-07 chrome-free wave).
    expect(await screen.findByRole("button", { name: "Submit to secure ledger" })).toBeInTheDocument();
    expect(screen.getByText(/no one can see who they come from/)).toBeInTheDocument();
    expect(document.querySelector(".home-orb")).not.toBeNull();
    // Stats tab renders the anonymized collective stats from demo data.
    fireEvent.click(screen.getByRole("link", { name: "Stats" }));
    expect(screen.getByText("Anonymized collective stats")).toBeInTheDocument();
    // History tab lists the member's own past logs.
    fireEvent.click(screen.getByRole("link", { name: "History" }));
    expect(screen.getByText(/yours alone/)).toBeInTheDocument();
  });

  // Regression (WL-23): both stepper buttons used to answer to the field's own
  // name, so a screen-reader user heard "Priority, button" twice with nothing
  // to tell minus from plus. The group keeps the field name; the buttons say
  // what they do to it.
  it("gives each stepper button a distinct accessible name", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/workload?demo=1");
    render(<App />);
    expect(await screen.findByRole("group", { name: "Priority" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease Priority" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Increase Priority" })).toBeInTheDocument();
    // The old shape — a button whose whole name is just the field — is gone.
    expect(screen.queryByRole("button", { name: "Priority" })).toBeNull();
  });

  it("renders the forms hub in demo and opens a template editor", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/forms?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Forms" })).toBeInTheDocument(); // nav.forms
    expect(screen.getByText(/go only to the committee for review/)).toBeInTheDocument(); // mforms.sub
    expect(document.querySelector(".home-orb")).not.toBeNull(); // member view keeps the phone chrome (Home orb)
    // The template card resumes the member's existing grievance draft at its
    // saved second step instead of manufacturing a blank first step.
    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    expect(screen.getByRole("heading", { name: "What happened" })).toBeInTheDocument(); // forms.step.detail
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument(); // forms.next
  });

  it("demo settings mints a canned calendar link without a backend", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/settings/calendar?demo=1");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Get calendar link" }));
    // The toast promises a copyable link, so demo mode must actually render
    // one — a canned 48-char token the same shape as a real minted token.
    const input = await screen.findByRole("textbox", { name: "Calendar" });
    expect(input.value).toBe(`${window.location.origin}/api/calendar?token=${"demo".repeat(12)}`);
    expect(screen.getByText("Copy this link now — it won't be shown again.")).toBeInTheDocument();
  });

  it("keeps account-security and live-session controls out of explicit fixture demo settings", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/settings/sessions?demo=1");
    render(<App />);
    expect(await screen.findByText("Preview data")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Security" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
    expect(screen.queryByText("SMS updates")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    // The avatar is named by its visible initials, then "Profile" (#7550).
    fireEvent.click(screen.getByRole("button", { name: /^\S+ Profile$/ }));
    const profile = await screen.findByRole("dialog");
    expect(within(profile).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it.each([
    ["/m/settings/", "Settings"],
    ["/m/messages/", "Messages"],
  ])("resolves direct trailing-slash member route %s", async (path, heading) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  });

  it("resolves trailing-slash staff tools and role desks without weakening unknown-path 404s", async () => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m/tasks/?demo=1");
    const first = render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Board" })).toBeInTheDocument();
    first.unmount();

    window.history.replaceState({}, "", "/m/not-a-route/");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });

  it("normalizes trailing slashes during history navigation", async () => {
    render(<App />);
    window.history.replaceState({}, "", "/m/settings/");
    fireEvent.popState(window);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  });

  it("demo steward hat shows the forms review inbox", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "steward" } });
    choosePage(await findPageMenuTrigger(), "/m/steward/forms");
    expect(await screen.findByText("Committee review inbox")).toBeInTheDocument();
    expect((await screen.findAllByText(/Workplace issue report/)).length).toBeGreaterThan(0);
  });

  // The route-chunk warm-up waits WARM_UP_DELAY_MS (3 s) after the data
  // resolves, then asks for idle time with a 4 s timeout; in the demo it warms
  // every hat's chunks. Driven on a fake clock so coverage of the loader table
  // never depends on how long another test happened to run.
  it("warms every demo route chunk only after the delay, at idle time, and cancels on unmount", async () => {
    const requestIdle = vi.fn(() => 7);
    const cancelIdle = vi.fn();
    window.requestIdleCallback = requestIdle;
    window.cancelIdleCallback = cancelIdle;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      primeDemoHat("member");
      window.history.replaceState({}, "", "/m?demo=1");
      const { unmount } = render(<App />);
      expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2_999));
      expect(requestIdle).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(requestIdle).toHaveBeenCalledTimes(1);
      const [warm, options] = requestIdle.mock.calls[0];
      expect(options).toEqual({ timeout: 4000 });
      warm();
      vi.useRealTimers();
      await vi.dynamicImportSettled();
      unmount();
      expect(cancelIdle).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
      delete window.requestIdleCallback;
      delete window.cancelIdleCallback;
    }
  });

  it("lets a demo visitor switch freely across every hat", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    // Member hat keeps its home space — the three-card layer since the
    // 2026-08-05 card-nav wave.
    expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(document.querySelector(".card-nav")).not.toBeNull();

    // The hat picker is one native select on the compact demo bar; switching
    // is a change event, and the bar itself stays on every hat.
    const hatPicker = () => screen.getByRole("combobox", { name: "Switch role" });

    // Steward role: the desk loads on demo data (no backend) and the member
    // card layer is gone.
    fireEvent.change(hatPicker(), { target: { value: "steward" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Page menu" })).getByRole("link", { name: "Worker requests", hidden: true })).toBeInTheDocument();
    expect(document.getElementById("steward-requests")).toBeNull();
    expect(window.location.pathname).toBe("/m/steward");
    expect(document.querySelector(".card-nav")).toBeNull();

    window.history.replaceState({}, "", "/m?demo=1");
    fireEvent.popState(window);
    expect(document.querySelector(".card-nav")).not.toBeNull();
    expect(document.getElementById("steward-requests")).toBeNull();
    expect(document.getElementById("steward-forms")).toBeNull();
    expect(document.getElementById("steward-caseload")).toBeNull();

    // Coordinator + Advisor hats route to their staff dashboards. The
    // coordinator plane is now the real data-driven component on seed data.
    fireEvent.change(hatPicker(), { target: { value: "coordinator" } });
    expect(window.location.pathname).toBe("/m/coordinator");
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    expect(document.querySelector(".card-nav")).toBeNull();

    // The advisor plane is now the real data-driven component on seed data.
    fireEvent.change(hatPicker(), { target: { value: "advisor" } });
    expect(window.location.pathname).toBe("/m/advisor");
    expect(await screen.findByText("Campaign health")).toBeInTheDocument();

    // Admin + President hats render their dashboards.
    fireEvent.change(hatPicker(), { target: { value: "admin" } });
    expect(await screen.findByText("Campaign admin")).toBeInTheDocument();
    // The organization-role heading lives deeper in the lazy-loaded AdminView chunk (#566);
    // await it rather than assuming it flushed on the same tick as the heading.
    expect(await within(screen.getByRole("navigation", { name: "Page menu" })).findByRole("link", { name: "Organization roles & access", hidden: true })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/admin");

    fireEvent.change(hatPicker(), { target: { value: "vp" } });
    expect(await screen.findByText("Leadership overview")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/vp");

    // Back to the member hat restores the member home space and its cards.
    fireEvent.change(hatPicker(), { target: { value: "member" } });
    expect(screen.getByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(document.querySelector(".card-nav")).not.toBeNull();

    // No Exit demo on the phone chrome (owner decision). Union
    // Ground keeps one on the rail-shell demo bar: tests/desktop-shell.test.jsx.
    expect(screen.queryByRole("button", { name: "Exit demo" })).not.toBeInTheDocument();
  });

  // Replaces the shortcut-bubble default-set test: the 2026-08-07 chrome-free
  // wave retired the bubble entirely. What must survive it: the shortcut
  // floating machinery is truly gone, the in-card Pinned section exists,
  // Compass keeps its PR8 semantics (a button opening the Assistant overlay,
  // never a route), and /m/search stays a live routed view.
  it("retires the shortcut bubble; Compass stays an overlay and Search stays route-only", async () => {
    render(<App />);
    expect(document.querySelector(".shortcut-bubble__fab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Shortcuts" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Pinned shortcuts" })).toBeInTheDocument();
    // Compass opens from the drawer card's row as an overlay, not a route.
    openDirectoryCompass();
    expect(await screen.findByRole("dialog", { name: "Union Ground Guide" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");
    fireEvent.click(screen.getByRole("button", { name: "Close and discard this draft" }));

    // Search has no chrome entry point, but the route is still alive: a deep
    // link lands on the full search screen.
    window.history.replaceState({}, "", "/m/search");
    fireEvent.popState(window);
    expect(await screen.findByRole("searchbox")).toBeInTheDocument();
    expect(screen.getByText(/Search everything you have/)).toBeInTheDocument();
  });

  // The two tests this pair replaces pinned Tasks as a MEMBER surface (a tab
  // in the bottom nav). That entry point is gone by owner decision
  // (2026-07-27): work coordination is a staff tool, entered from the
  // coordinator/steward planes, and /m/tasks redirects a role-less member.
  it("keeps Tasks out of the member navigation and redirects a role-less /m/tasks visit", async () => {
    window.history.replaceState({}, "", "/m/tasks");
    render(<App />);
    // The redirect replaces the stale link with the member home…
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");
    // …and the tab bar offers no way back in.
    expect(screen.queryByRole("link", { name: "Tasks" })).not.toBeInTheDocument();
    expect(screen.queryByText("Move the work together")).not.toBeInTheDocument();
  });

  // The staff PLANES get the same treatment as the tool: without the role,
  // the member Today screen must not render under a staff URL — the URL is
  // repaired to /m instead, exactly like the /m/tasks redirect above.
  it("redirects a role-less member off a staff plane route instead of rendering Today under it", async () => {
    window.history.replaceState({}, "", "/m/admin");
    const historyLength = window.history.length;
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    expect(window.history.length).toBe(historyLength);
    const explanation = screen.getByText("The Admin desk needs the Admin role, so Home opened instead.");
    expect(explanation.closest('[role="status"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Admin", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Admin desk" })).not.toBeInTheDocument();
    vi.useFakeTimers();
    try {
      await act(() => vi.advanceTimersByTimeAsync(7000));
      expect(explanation).toBeInTheDocument();
      expect(window.location.pathname).toBe("/m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaceStates a demo Steward staff deep link to the Steward plane with a notice", async () => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m/advisor?demo=1");
    const historyLength = window.history.length;
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m/steward"));
    expect(window.history.length).toBe(historyLength);
    // Union Ground's demo starts as Worker (DEFAULT_SAMPLE_HAT is "member";
    // a staff hat is only ever the visitor's own choice), so the hat the visitor
    // already wore is kept and Union Ground's "starts as Steward" claim is not
    // made.
    expect(screen.queryByText(/This link starts as Steward/)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Switch role" })).toHaveValue("steward");
  });

  it("uses generic hat-refusal copy after the initial Steward deep-link fallback", async () => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m/advisor?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m/steward"));
    expect(screen.queryByText(/This link starts as Steward/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "member" } });
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    window.history.pushState({}, "", "/m/advisor?demo=1");
    fireEvent.popState(window);
    expect(await screen.findByText(/Your Worker role cannot open that page. Opening Home instead./)).toBeInTheDocument();
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    expect(screen.queryByText(/This link starts as Steward/)).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");
  });

  it("does not raise a hat-refusal toast when a member loads Home in demo mode", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m");
    expect(screen.queryByText(/cannot open that page/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/This link starts as Steward/)).not.toBeInTheDocument();
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("silently remaps SAMPLE Steward Home onto the Steward plane on a tablet rail", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query.includes("min-width: 768px") && query.includes("max-width: 1023px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    try {
      primeDemoHat("steward");
      window.history.replaceState({}, "", "/m?demo=1");
      render(<App />);
      expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
      await waitFor(() => expect(window.location.pathname).toBe("/m/steward"));
      expect(screen.queryByText(/cannot open that page/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Opening Steward instead/)).not.toBeInTheDocument();
      expect(document.querySelector(".toast")).toBeNull();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it("does not toast when an explicit hat switch leaves another staff plane", async () => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m/steward?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    expect(document.querySelector(".toast")).toBeNull();
    expect(screen.queryByText(/cannot open that page/i)).not.toBeInTheDocument();
  });

  it("names the worn hat and destination on a real staff-plane refusal", async () => {
    primeDemoHat("coordinator");
    window.history.replaceState({}, "", "/m/admin?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/m/coordinator"));
    expect(screen.getByText("Your Campaign lead role cannot open that page. Opening Issue queue instead.")).toBeInTheDocument();
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    expect(screen.queryByText(/This link starts as Steward/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Opening Steward instead/)).not.toBeInTheDocument();
  });

  it("phone Home with a worn steward hat mounts at most the overview desk section", async () => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect(document.querySelector(".card-nav")).not.toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: "Committee desk" })).toBeInTheDocument();
    expect(document.getElementById("steward-caseload")).toBeNull();
    expect(document.getElementById("steward-requests")).toBeNull();
    expect(document.getElementById("steward-forms")).toBeNull();
  });

  it("keeps a created task after leaving and re-entering through the coordinator plane", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Campaign duty" }));
    // The demo hat CAN open the tool (the tour narrates this screen), and the
    // staff tool hides the member bottom nav.
    // Every column's composer ghost row shares the "New task" name with the
    // toolbar button; the toolbar's is first in DOM order (PlaneHeader
    // renders before the board).
    fireEvent.click((await screen.findAllByRole("button", { name: "New task" }))[0]);
    expect(screen.queryByRole("link", { name: "Today" })).not.toBeInTheDocument();
    // The full create form retired with the t0ggles rebuild: "New task" drops
    // into the first column's inline composer, and Enter files the card.
    const composer = await screen.findByPlaceholderText("Task title…");
    fireEvent.change(composer, { target: { value: "Schedule member training" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("Schedule member training")).toBeInTheDocument();

    // Leave via the hat picker, come back through the plane entrance — the
    // only real way in now.
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "member" } });
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Campaign duty" }));
    expect(await screen.findByText("Schedule member training")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/tasks");
  });

  // The search tests reach /m/search by URL now that the tab is gone (wave
  // 2a): the route, the payload hand-off, and the consume-once guard are the
  // semantics under test, not the entry gesture.
  it("search deep-links land on the item itself, not just its view", async () => {
    window.history.replaceState({}, "", "/m/search");
    render(<App />);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "briefing" } });
    // Broadcast hit: opens Messages on the broadcasts tab with the dialog up.
    fireEvent.click(screen.getByRole("button", { name: /Campaign briefing 1/ }));
    expect(window.location.pathname).toBe("/m/messages");
    expect(await screen.findByRole("dialog")).toHaveTextContent("Campaign briefing 1");
  });

  it("back/forward does not re-consume a search deep-link", async () => {
    window.history.replaceState({}, "", "/m/search");
    render(<App />);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "briefing" } });
    fireEvent.click(screen.getByRole("button", { name: /Campaign briefing 1/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Campaign briefing 1");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // Browser Back to /m/search, then Forward to /m/messages: the payload
    // must be gone — the broadcast dialog must NOT re-open (which would also
    // re-fire its mark-read write).
    window.history.replaceState({}, "", "/m/search");
    fireEvent.popState(window);
    window.history.replaceState({}, "", "/m/messages");
    fireEvent.popState(window);
    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("search finds a form template by its displayed name in demo", async () => {
    window.history.replaceState({}, "", "/m/search");
    render(<App />);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "workplace issue report" } });
    // The member's own draft ("Your forms") and the template both match. The
    // template entry still resolves that draft instead of starting blank.
    const group = screen.getByText("Start a form").closest("section");
    fireEvent.click(within(group).getByRole("button", { name: /Workplace issue report/ }));
    // Lands inside the Forms editor on the saved draft step.
    expect(window.location.pathname).toBe("/m/forms");
    expect(await screen.findByRole("heading", { name: "What happened" })).toBeInTheDocument();
  });

  it("search hands a question to Compass prefilled", async () => {
    window.history.replaceState({}, "", "/m/search");
    render(<App />);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "telework rights" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask Union Ground Guide about/ }));
    const dialog = await screen.findByRole("dialog", { name: "Union Ground Guide" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Union Ground Guide a question" })).toHaveValue("telework rights");
  });

  it("dismisses rights notices and keeps the steward action usable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    render(<App />);
    // The rights screen (/m/rights) is the drawer card's "Know your rights"
    // row since the chrome-free wave retired the bubble's Learn shortcut.
    fireEvent.click(screen.getByRole("button", { name: "All features" }));
    // The pinned shortcut shares the row's name since #9527; take the menu row.
    fireEvent.click(within(document.querySelector(".card-nav__panel--features")).getAllByRole("link", { name: /Organizing rights/ }).at(-1));
    // Wave 2b: the Learn landing is the prototype guide list; the Weingarten
    // walkthrough steps live behind the START-HERE hero. Rights is its own
    // chunk, and the import resolves on the real macrotask queue — freezing
    // the clock before it lands would leave Suspense hanging forever. Mount
    // and open the walkthrough first, THEN take over the toast timers.
    fireEvent.click(await screen.findByRole("button", { name: "Start the walkthrough" }));
    expect(screen.getByRole("button", { name: /You do not have to answer who is involved/ })).toBeInTheDocument();
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /You do not have to answer who is involved/ }));
    });
    expect(screen.getAllByText("Progress saved")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(3300));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the script" }));
    });
    expect(screen.getByText("Script copied")).toBeInTheDocument();

    // The steward CTA is the learn-steward card's Request button ("Request a
    // steward now" is the card's lead-in copy, not the control).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Request" }));
    });
    expect(screen.getAllByText("Committee request sent").length).toBeGreaterThan(0);

    // The prototype's toast clock: 4.2 s, then a .3s fade and removal at 320 ms.
    act(() => vi.advanceTimersByTime(4200));
    act(() => vi.advanceTimersByTime(320));
    expect(screen.queryByText("Committee request sent")).not.toBeInTheDocument();
  });
});

// The live board merge. App forces demo mode under vitest, so the realtime
// effect cannot be exercised through a render — the merge DECISIONS are
// therefore exported pure (applyBoardEvent / localTaskRowWins, the same move
// owesASecondFactor made) and held here directly, with honest text pins for
// the wiring that feeds them, in the session-guard.test.js style.
describe("live board merge (last write wins)", () => {
  // Raw snake_case broadcast row, the shape chapterTaskFromRow maps.
  const boardRow = (id, updatedAt, extra = {}) => ({
    id,
    chapter_id: "wor",
    task_number: 7,
    title: "Flyer run",
    description: "",
    status: "backlog",
    priority: "medium",
    workstream: "Organizing",
    assignee_id: null,
    assignee_name: "",
    start_date: "2026-08-01",
    due_date: "2026-08-08",
    progress: 0,
    blocked: false,
    milestone: false,
    order_index: 100,
    created_by: "u1",
    done_at: null,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: updatedAt,
    ...extra,
  });
  const taskEvent = (operation, row) => ({ table: "chapter_tasks", operation, record: row });

  it("applies a newer broadcast over the local copy and refuses a stale one", () => {
    const prev = { tasks: [chapterTaskFromRow(boardRow("t1", "2026-08-01T12:00:00Z"))] };
    const newer = applyBoardEvent(prev, taskEvent("UPDATE", boardRow("t1", "2026-08-01T12:05:00Z", { status: "in_progress" })));
    expect(newer.tasks[0].status).toBe("in_progress");
    // A late-delivered older row must not snap the card back — same object,
    // not merely same content, so no render is spent on it either.
    expect(applyBoardEvent(prev, taskEvent("UPDATE", boardRow("t1", "2026-08-01T11:55:00Z")))).toBe(prev);
  });

  // FINDING-3 shape: the gap refetch's snapshot was read BEFORE a broadcast
  // arrived, so committing the snapshot alone would erase the newer row — and
  // broadcasts are fire-and-forget, so nothing would ever repair it. The
  // commit replays the buffered events through the same reducer instead.
  it("a broadcast arriving mid-refetch survives the snapshot replace", () => {
    // Live state already holds the broadcast the effect applied optimistically.
    const live = { tasks: [chapterTaskFromRow(boardRow("t1", "2026-08-01T12:05:00Z", { status: "in_progress" }))], workstreams: [] };
    // The refetch snapshot predates that broadcast.
    const board = { tasks: [chapterTaskFromRow(boardRow("t1", "2026-08-01T12:00:00Z"))], workstreams: [] };
    const buffered = [taskEvent("UPDATE", boardRow("t1", "2026-08-01T12:05:00Z", { status: "in_progress" }))];
    // The exact commit shape the effect runs: snapshot first, then replay.
    let next = { ...live, tasks: board.tasks ?? live.tasks, workstreams: board.workstreams ?? live.workstreams };
    for (const event of buffered) next = applyBoardEvent(next, event);
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0].status).toBe("in_progress");
    expect(next.tasks[0].updatedAt).toBe("2026-08-01T12:05:00Z");
  });

  it("replays a buffered delete so the snapshot cannot resurrect the card", () => {
    const board = { tasks: [chapterTaskFromRow(boardRow("t1", "2026-08-01T12:00:00Z"))], workstreams: [] };
    const buffered = [
      taskEvent("UPDATE", boardRow("t1", "2026-08-01T12:05:00Z", { deleted_at: "2026-08-01T12:05:00Z" })),
      { table: "chapter_workstreams", operation: "INSERT", record: { id: "w1", name: "Bargaining" } },
    ];
    let next = { tasks: board.tasks, workstreams: board.workstreams };
    for (const event of buffered) next = applyBoardEvent(next, event);
    // The soft-deleted card is gone and the workstream event replayed too.
    expect(next.tasks).toHaveLength(0);
    expect(next.workstreams.map((item) => item.name)).toEqual(["Bargaining"]);
  });

  // FINDING-4 shape: two rapid writes commit A then B server-side but deliver
  // their HTTP responses B then A. The stale A response must lose to the local
  // row B already put in place; an equal-or-newer response still applies.
  it("keeps the local row over a stale mutation response, but lets an equal or newer one through", () => {
    const local = chapterTaskFromRow(boardRow("t1", "2026-08-01T12:05:00Z"));
    expect(localTaskRowWins(local, chapterTaskFromRow(boardRow("t1", "2026-08-01T12:00:00Z")))).toBe(true);
    // Strictly newer only: the row's OWN response echoes its own timestamp.
    expect(localTaskRowWins(local, chapterTaskFromRow(boardRow("t1", "2026-08-01T12:05:00Z")))).toBe(false);
    expect(localTaskRowWins(local, chapterTaskFromRow(boardRow("t1", "2026-08-01T12:06:00Z")))).toBe(false);
    // No local row at all: the response applies (create's first landing).
    expect(localTaskRowWins(undefined, chapterTaskFromRow(boardRow("t1", "2026-08-01T12:00:00Z")))).toBe(false);
  });

  // #8211 gate round 1 (r2s1, r2s4): the conversion receipt is the bare RPC
  // row. It must come back with the task's co-assignees, or the editor's next
  // assignee change would drop them, and it must lose to a newer row.
  describe("General -> specialized conversion receipt", () => {
    const roster = [
      { id: "u1", fullName: "Darnell Foster" },
      { id: "u2", fullName: "Maria Santos" },
    ];
    const assignments = [
      { id: "a1", taskId: "t1", chapterId: "wor", assigneeId: "u1", position: 0 },
      { id: "a2", taskId: "t1", chapterId: "wor", assigneeId: "u2", position: 1 },
    ];
    const details = (updatedAt) => ({ taskId: "t1", templateKey: "meeting_event", flowStep: "proposed", updatedAt });
    const board = (task, extra = {}) => ({ tasks: [task], taskAssignments: assignments, taskAssignees: roster, taskTemplateDetails: [], ...extra });
    const receipt = (updatedAt, extra = {}) => ({
      task: chapterTaskFromRow(boardRow("t1", updatedAt, { assignee_id: "u1", task_type: "meeting_event", ...extra })),
      details: details(updatedAt),
    });

    it("keeps every co-assignee on the converted task", () => {
      const local = { ...chapterTaskFromRow(boardRow("t1", "2026-08-01T12:00:00Z", { assignee_id: "u1" })), assigneeIds: ["u1", "u2"] };
      const next = applyTaskConversionResult(board(local), receipt("2026-08-01T12:05:00Z"));
      expect(next.tasks[0]).toMatchObject({ taskType: "meeting_event", assigneeIds: ["u1", "u2"], assigneeNames: ["Darnell Foster", "Maria Santos"] });
      expect(next.taskTemplateDetails).toEqual([details("2026-08-01T12:05:00Z")]);
    });

    it("leaves a newer row in place when the receipt lands after it", () => {
      const newer = { ...chapterTaskFromRow(boardRow("t1", "2026-08-01T12:09:00Z", { status: "done", task_type: "meeting_event" })), assigneeIds: ["u1", "u2"] };
      const newerDetails = details("2026-08-01T12:09:00Z");
      const prev = board(newer, { taskTemplateDetails: [newerDetails] });
      const next = applyTaskConversionResult(prev, receipt("2026-08-01T12:05:00Z", { status: "to_do" }));
      expect(next.tasks[0]).toBe(newer);
      expect(next.taskTemplateDetails).toEqual([newerDetails]);
    });
  });

  it("recomputes a task's ordered assignee set from assignment broadcasts", () => {
    const task = chapterTaskFromRow(boardRow("t1", "2026-08-01T12:00:00Z", {
      assignee_id: "u2",
      assignee_name: "Maria Santos",
    }));
    const prev = {
      tasks: [task],
      taskAssignments: [{ id: "a1", taskId: "t1", chapterId: "wor", assigneeId: "u2", position: 0 }],
      taskAssignees: [
        { id: "u2", fullName: "Maria Santos" },
        { id: "u3", fullName: "Jordan Lee" },
      ],
    };
    const next = applyBoardEvent(prev, {
      table: "chapter_task_assignments",
      operation: "INSERT",
      record: {
        id: "a2", task_id: "t1", chapter_id: "wor", assignee_id: "u3", position: 1, assigned_at: "now",
      },
    });
    expect(next.tasks[0].assigneeIds).toEqual(["u2", "u3"]);
    expect(next.tasks[0].assigneeNames).toEqual(["Maria Santos", "Jordan Lee"]);
  });

  // Text pins for the wiring the pure tests cannot reach through a render —
  // honest about being tripwires rather than behavioural proof.
  describe("App wiring", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");

    it("buffers board events during the gap refetch and replays them on commit", () => {
      expect(app).toContain("const refetchQueue = createBoardRefetchQueue({");
      expect(app).toContain("refetchQueue.note(event);");
      expect(app).toContain("refetchQueue.refetch()");
      expect(app).toContain("setData((prev) => applyBoardEvent(prev, event));");
      expect(app).toContain("for (const event of buffered) next = applyBoardEvent(next, event);");
      expect(app).toContain("refetchQueue.close();");
    });

    it("replays board events over a full refresh too", () => {
      expect(app).toContain("guardRef.current.boardEventsSince(ticket)");
      expect(app).toContain("guard.noteRealtimeBoardEvent(event);");
    });

    it("routes the app's own mutation responses through the shared comparison", () => {
      expect(app).toContain("task.id === taskId && !localTaskRowWins(task, updated)");
      expect(app).toContain("if (localTaskRowWins(existing, created)) return current;");
      // The reducer is the ONLY place a broadcast row meets local state.
      expect(app).toContain("if (localTaskRowWins(existing, task)) return prev;");
    });

    it("does not restart the authenticated boot load when the session object identity changes", () => {
      expect(app).toContain("loadShellRef.current(session)");
      expect(app).toContain("}, [session?.user?.id, demoActive, sessionGeneration]);");
      expect(app).not.toContain("}, [session?.user?.id, loadShell, demoActive]);");
    });
  });
});

describe("hat-refusal toast rail clearance", () => {
  const styles = readFileSync(resolve("src/styles.css"), "utf8").replace(/\r\n/g, "\n");

  // Centering the toast on (rail-width, viewport-width) rather than the
  // viewport alone is what keeps it off the rail at any rail/toast size; a
  // literal arithmetic check here would only ever exercise numbers typed
  // into this file, never the actual --shell-rail-width or toast box from
  // src/styles.css, so it could never fail from a real CSS regression. A
  // Playwright bounding-box check against the live layout would have teeth;
  // this pins only the formula that guarantees the centering invariant.
  it("pins the toast centering formula and phone placement in src/styles.css", () => {
    expect(styles).toMatch(
      /\.sg-app--tablet \.toast,\s*\.sg-app--desktop \.toast\s*\{[^}]*left:\s*calc\(var\(--shell-rail-width\) \+ \(100vw - var\(--shell-rail-width\)\) \/ 2\)/,
    );
    expect(styles).toMatch(/\.toast\s*\{[^}]*left:\s*50%;[^}]*bottom:\s*126px/);
    // #7660: that fixed placement remains for the signed-out notice and for
    // Work. The classic shell wins with an in-flow rule so Draft saved cannot
    // cover the form. The alternate shell keeps its own .ugalt .toast placement.
    expect(styles).toMatch(/\.sg-app:not\(\.ugalt\):not\(\.sg-app--tasks\) \.toast\s*\{[^}]*position:\s*relative;[^}]*bottom:\s*auto;[^}]*transform:\s*none/);
    const app = readFileSync(resolve("src/App.jsx"), "utf8");
    const mainStart = app.indexOf('id="main-content"');
    const main = app.slice(mainStart, app.indexOf("</main>", mainStart));
    expect(main).toContain("{altShell ? null : <ActionToast {...noticeToast} />}");
    expect(app.match(/\{altShell \? null : <ActionToast \{\.\.\.noticeToast\} \/>\}/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Union Ground identity on the shell.
// ---------------------------------------------------------------------------
describe("Union Ground front door and organizing routes", () => {
  it("keeps the fictional demo available when no backend is configured", () => {
    expect(shouldShowConfigurationGate(false, true, false)).toBe(false);
    expect(shouldShowConfigurationGate(false, false, false)).toBe(true);
  });

  it("renders the public Union Ground front door at the root route", async () => {
    window.history.replaceState({}, "", "/");
    render(<RoutedApp />);
    expect(await screen.findByRole("heading", { name: /Organize first/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Today" })).not.toBeInTheDocument();
  });

  it("routes public connection requests outside the member authentication shell", async () => {
    window.history.replaceState({}, "", "/connect");
    render(<RoutedApp />);
    expect(await screen.findByRole("heading", { name: "Start with a safe connection." })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Today" })).not.toBeInTheDocument();
  });

  it("routes workers to organizing Work", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/work?demo=1");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "My work" }, { timeout: 8_000 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/work");
    expect(screen.getByText("PSG-104")).toBeInTheDocument();
  });

  it("opens the Organize plane at /m/organize, not the campaign workspace hub", async () => {
    // Hats are explicit: the visitor wears Organizer before the plane opens.
    primeDemoHat("organize");
    window.history.replaceState({}, "", "/m/organize?demo=1");
    render(<App />);
    await waitFor(() => expect(document.querySelector(".app-column--organize")).not.toBeNull(), { timeout: 8_000 });
    expect(window.location.pathname).toBe("/m/organize");
  });

  it("does not route the left-out union-only destinations", async () => {
    for (const path of [
      "/m/dues", "/m/clauses", "/m/civic/officials", "/m/civic/officer/local",
      "/m/integrations/sso", "/m/admin/rewards", "/m/admin/reward-economy",
      "/m/admin/catalog-verification", "/m/admin/catalog-vouch", "/m/admin/catalog-verifier",
      "/m/coordinator/settings", "/m/coordinator/cases/board",
    ]) {
      window.history.replaceState({}, "", path);
      const view = render(<App />);
      expect(await screen.findByRole("heading", { level: 1 }, { timeout: 8_000 })).toBeInTheDocument();
      expect(document.querySelector(".public-directory, .dues-screen, .dues-workspace, .civic-screen, .civic-host, .clause-quickref, .reward-economy, .case-procedure-board")).toBeNull();
      expect(screen.queryByRole("heading", { name: /\bdues\b|contract clauses|civic|reward economy|single sign-on|catalog verification|procedure/i })).toBeNull();
      view.unmount();
    }
  });

  it("answers the left-out public directory and union catalog addresses with the 404 page", async () => {
    for (const path of ["/chapters", "/chapters/demo", "/events/demo-meeting", "/unions", "/orgs/example-local-1", "/unions/claim/confirm"]) {
      window.history.replaceState({}, "", path);
      const view = render(<RoutedApp />);
      expect(await screen.findByRole("heading", { level: 1, name: t("en", "notFound.title") }, { timeout: 8_000 })).toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("demo fixture identity", () => {
  // The demo session is derived from the fixture, so the session guard never
  // treats the seeded data as another member's, and its address is on a
  // reserved domain rather than a sibling product's.
  it("uses the same member identity the fixture seeds, on a reserved domain", () => {
    const session = demoSessionFor(fallbackData);
    expect(session.user.id).toBe(fallbackData.member.id);
    expect(session.user.email).toBe("demo@unionground.invalid");
  });
});

describe("sign-out scope", () => {
  // scope "local" is load-bearing: the default "global" revokes every refresh
  // token on the account, so "Sign out instead" on a TOTP challenge would also
  // kill the member's still-working phone session.
  it("signs out this browser only unless the member asks for every device", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const sessions = readFileSync(resolve(process.cwd(), "src/lib/sessionManagement.js"), "utf8");
    expect(sessions).toMatch(/export async function signOutSafely\(client, \{\s*scope = "local",/);
    // signOutOnce runs signOutAndForget with the same scope, once per scope at a
    // time; every device stays the only global sign-out, and a shared demo
    // persona session never offers it.
    expect(app).toContain('onSignOut={fixtureDemo ? null : () => signOutOnce("local", true)}');
    expect(app).toContain('onSignOutEverywhere={fixtureDemo || sharedPersonaSession ? null : () => signOutAndForget("global", true)}');
  });
});

describe("top-level error boundary", () => {
  function Boom() {
    throw new Error("render fault");
  }

  it("renders a recoverable message instead of a blank document", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("This screen stopped working");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("stays out of the way when nothing fails", () => {
    render(<AppErrorBoundary><p>Member shell</p></AppErrorBoundary>);
    expect(screen.getByText("Member shell")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// Union Ground's hourly-token-refresh behaviour tests mocked supabase.js and
// loadMemberApp, both of which Union Ground's shell replaced (createMember
// SessionLoader and the captured-session client). The property is pinned on
// the boot effect itself until a behavioural harness for the new loader lands.
describe("hourly token refresh", () => {
  it("keys the boot load on member identity, never on the session object", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toMatch(/\}, \[session\?\.user\?\.id, demoActive, sessionGeneration\]\);/);
    expect(app).toContain("loadShellRef.current(session)");
  });
});
