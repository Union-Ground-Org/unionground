import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { normalizeHistory } from "../src/features/learningPeriod/model.js";
import { LearningPeriodBanner, LearningPeriodProvider, useLearningPeriodController } from "../src/features/learningPeriod/LearningPeriod.jsx";
import { announceLearningUndone, useLearningUndone } from "../src/features/learningPeriod/undoneSignal.js";
import { learningUndoMemberResources, memberMutationResources } from "../src/lib/memberSessionLoader.js";
import { NumbersView } from "../src/views/NumbersView.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { MemberEngagement } from "../src/features/engagement/MemberEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { AnnouncementReaderSession } from "../src/features/platformAnnouncements/PlatformAnnouncements.jsx";
import { useChannelControls } from "../src/features/messaging/channelControlsApi.js";

// REQ-UG-LEARNING-PERIOD-PREFERENCE-TABLES-JOURNAL-20261104 (#7027),
// gate round 1 on #7104: an undo of your own preference changes the database,
// and every web surface that shows that preference must re-read it, or the
// next save writes the undone choice back.
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

const DAY = 24 * 60 * 60 * 1000;

function entry(id, actionKind, extra = {}) {
  return {
    id, actionKind, domain: "settings", disposition: "reverse", targetTable: "public.member_report_preferences", targetId: "member-1",
    parentEntryId: null, state: "active", version: 1, createdAt: "2026-11-04T14:00:00Z", undoneAt: null, keptAt: null,
    sent: false, undoable: true, ...extra,
  };
}

function Harness({ api, children }) {
  const controller = useLearningPeriodController({ api });
  return <LearningPeriodProvider value={controller}>{children(controller)}</LearningPeriodProvider>;
}

function learningApi(entries, undo) {
  return {
    period: vi.fn().mockResolvedValue({ organizationId: "org", used: true, running: true, periodId: "p", lengthDays: 14,
      startsAt: new Date(Date.now() - DAY).toISOString(), endsAt: new Date(Date.now() + 9 * DAY).toISOString(),
      endedEarlyAt: null, closedAt: null, endAt: new Date(Date.now() + 9 * DAY).toISOString(), isAdmin: false }),
    history: vi.fn().mockResolvedValue({ running: true, entries: normalizeHistory({ entries }).entries }),
    undo,
  };
}

async function undoFromHistory(entries, undo, label) {
  const heard = vi.fn();
  function Listener() { useLearningUndone(["own_report_preferences", "own_workload_reminder"], heard); return null; }
  render(<LanguageProvider lang="en"><Harness api={learningApi(entries, undo)}>{(controller) => <>
    <Listener />
    <button type="button" onClick={controller.openHistory}>open history</button>
    <LearningPeriodBanner />
  </>}</Harness></LanguageProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "open history" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click((await within(dialog).findAllByRole("button", { name: `Undo: ${label}` })).at(-1));
  fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(undo).toHaveBeenCalled());
  return heard;
}

describe("the practice history announces what an undo took back", () => {
  it("names the kinds of the whole undone chain, and nothing for a refused undo", async () => {
    const entries = [
      entry("later", "own_report_preferences", { createdAt: "2026-11-04T14:05:00Z" }),
      entry("first", "own_report_preferences", { createdAt: "2026-11-04T14:01:00Z" }),
      entry("other", "own_workload_reminder", { targetTable: "private.workload_reminder_preferences", createdAt: "2026-11-04T14:03:00Z" }),
    ];
    const heard = await undoFromHistory(entries, vi.fn().mockResolvedValue({ status: "undone", undoneCount: 2 }), "Changed your My Reports layout");
    await waitFor(() => expect(heard).toHaveBeenCalledWith(["own_report_preferences"]));
    expect(heard).toHaveBeenCalledTimes(1);
    cleanup();
    const refused = await undoFromHistory([entry("only", "own_workload_reminder", { targetTable: "private.workload_reminder_preferences" })],
      vi.fn().mockRejectedValue(Object.assign(new Error("this has changed since your practice action"), { code: "40001" })),
      "Changed your workload reminder");
    await screen.findAllByText(/changed since/i);
    expect(refused).not.toHaveBeenCalled();
  });

  it("calls only the surfaces that show a kind it took back", () => {
    const reports = vi.fn();
    const channel = vi.fn();
    renderHook(() => { useLearningUndone(["own_report_preferences"], reports); useLearningUndone(["own_channel_notifications"], channel); });
    act(() => announceLearningUndone(["own_report_preferences", "own_report_preferences"]));
    expect(reports).toHaveBeenCalledWith(["own_report_preferences"]);
    expect(channel).not.toHaveBeenCalled();
  });

  it("re-reads the shell's My Reports and workload reminder resources for those kinds only", () => {
    expect(learningUndoMemberResources(["own_report_preferences"])).toEqual(["rpc:get_my_report_preferences"]);
    expect(learningUndoMemberResources(["own_workload_reminder"])).toEqual(memberMutationResources("setWorkloadReminderPreferences"));
    expect(learningUndoMemberResources(["own_workload_reminder"])).toContain("rpc:get_workload_reminder_preferences");
    expect(learningUndoMemberResources(["own_compass_workspace"])).toEqual([]);
  });
});

describe("My Reports adopts the layout an undo restored", () => {
  const DATA = { member: { id: "member-1", initials: "DF" }, metrics: { casesHandled: 4, tasksDone: 3, openCases: 1, resolvedCases: 3, caseTypes: [], weeks: [] } };
  const hiddenCards = () => [...document.querySelectorAll(".reports-card")].filter((card) => card.textContent.includes("My issues")).length;
  const view = (reportPreferences, onSavePreferences = vi.fn(async (config) => config)) => (
    <LanguageProvider lang="en"><NumbersView data={{ ...DATA, reportPreferences }} onSavePreferences={onSavePreferences} /></LanguageProvider>);

  it("shows the earlier layout, and the next save sends it rather than the undone one", async () => {
    const onSave = vi.fn(async (config) => config);
    const { rerender } = render(view({ order: [], hidden: ["cases"], custom: [] }, onSave));
    expect(hiddenCards()).toBe(0);
    // The undo re-read the layout from before the practice change.
    rerender(view({ order: [], hidden: [], custom: [] }, onSave));
    expect(hiddenCards()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move My issues up" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls.at(-1)[0].hidden).toEqual([]);
  });

  it("shows the default layout when the undo removed the only saved layout, not the device copy of the undone one", () => {
    const { rerender } = render(view({ order: [], hidden: ["cases"], custom: [] }));
    expect(hiddenCards()).toBe(0);
    rerender(view(null));
    expect(hiddenCards()).toBe(1);
  });

  // Gate round 2 on #7104: a page mounted after the undo must not seed from
  // the device copy, which still mirrors the layout the undo took back.
  it("opens with the default layout after the undo removed the saved layout, and overwrites the device copy", () => {
    window.localStorage.setItem("sg:member:member-1:reports:hidden", JSON.stringify({ cases: true }));
    window.localStorage.setItem("sg:member:member-1:reports:custom", JSON.stringify([{ id: "c-undone", metric: "pts", kind: "stat", range: "all" }]));
    const onSave = vi.fn(async (config) => config);
    render(view(null, onSave));
    expect(hiddenCards()).toBe(1);
    // The default layout is shown, not saved: nothing persists until the member edits.
    expect(onSave).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("sg:member:member-1:reports:hidden"))).toEqual({});
    expect(JSON.parse(window.localStorage.getItem("sg:member:member-1:reports:custom"))).toEqual([]);
  });

  it("still uses the device copy when the preferences read is unavailable", () => {
    window.localStorage.setItem("sg:member:member-1:reports:hidden", JSON.stringify({ cases: true }));
    render(<LanguageProvider lang="en"><NumbersView data={{ ...DATA, reportPreferences: null, reportPreferencesUnavailable: true }} /></LanguageProvider>);
    expect(hiddenCards()).toBe(0);
  });

  // Gate round 3 on #7104: a page that opened on the device copy while the
  // read failed drops it when a later read answers that the undo removed the
  // saved layout.
  it("drops the device copy it opened with when a later read finds no saved layout", () => {
    window.localStorage.setItem("sg:member:member-1:reports:hidden", JSON.stringify({ cases: true }));
    const unavailable = <LanguageProvider lang="en"><NumbersView data={{ ...DATA, reportPreferences: null, reportPreferencesUnavailable: true }} /></LanguageProvider>;
    const { rerender } = render(unavailable);
    expect(hiddenCards()).toBe(0);
    // A retry that fails again keeps the device copy.
    rerender(<LanguageProvider lang="en"><NumbersView data={{ ...DATA, reportPreferences: null, reportPreferencesUnavailable: true }} /></LanguageProvider>);
    expect(hiddenCards()).toBe(0);
    rerender(view(null));
    expect(hiddenCards()).toBe(1);
    expect(JSON.parse(window.localStorage.getItem("sg:member:member-1:reports:hidden"))).toEqual({});
  });
});

describe("the workload reminder form adopts the schedule an undo restored", () => {
  const data = (reminders) => ({ workload: { entries: [], stats: null, reminders } });

  it("replaces the form and saves the restored schedule", async () => {
    window.history.replaceState({}, "", "/m/workload?tab=reminders");
    const onSave = vi.fn(async (fields) => ({ ...fields, available: true }));
    const practice = { available: true, enabled: true, cadence: "weekly", weekday: 2, localHour: 8, timezone: "America/Chicago", nextDueAt: null };
    const restored = { available: true, enabled: false, cadence: "weekly", weekday: 1, localHour: 9, timezone: "America/New_York", nextDueAt: null };
    const wrap = (reminders) => <LanguageProvider lang="en"><WorkloadView data={data(reminders)} onLogWork={vi.fn()} onSaveReminder={onSave} /></LanguageProvider>;
    const { rerender } = render(wrap(practice));
    expect((await screen.findByRole("combobox", { name: "Time zone" })).value).toBe("America/Chicago");
    rerender(wrap(restored));
    expect(screen.getByRole("combobox", { name: "Time zone" }).value).toBe("America/New_York");
    expect(screen.getByRole("button", { name: /Enable workplace log reminders/ }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Save reminder schedule" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ enabled: false, weekday: 1, localHour: 9, timezone: "America/New_York" });
  });
});

describe("the Guide workspace re-reads itself after an undo", () => {
  const snapshot = (hiddenModules) => ({ quarterlyGate: {}, pulsePrompts: [], livePolls: [], surveys: [], actions: [], workspace: { moduleOrder: ["inbox", "surveys"], hiddenModules } });

  it("loads again and shows the restored modules", async () => {
    const load = vi.spyOn(engagementApi, "loadMember").mockResolvedValueOnce(snapshot(["surveys"])).mockResolvedValue(snapshot([]));
    vi.spyOn(engagementApi, "heartbeat").mockResolvedValue(null);
    render(<LanguageProvider lang="en"><MemberEngagement client={{ channel: () => ({ on() { return { subscribe: () => ({}) }; } }), removeChannel() {} }} organizationId="00000000-0000-4000-a000-000000000001" onNotice={vi.fn()} /></LanguageProvider>);
    const surveys = await screen.findByRole("checkbox", { name: "Surveys" });
    expect(surveys.checked).toBe(false);
    const before = load.mock.calls.length;
    act(() => announceLearningUndone(["own_compass_workspace"]));
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Surveys" }).checked).toBe(true));
  });
});

describe("platform updates re-read whether they are hidden after an undo", () => {
  it("reads the feed again", async () => {
    const feed = vi.fn().mockResolvedValueOnce({ items: [], generation: 1, hidden: true }).mockResolvedValue({ items: [], generation: 1, hidden: false });
    render(<AnnouncementReaderSession api={{ feed, settings: vi.fn(() => Promise.reject(new Error("denied"))), preference: vi.fn() }} locale="en" />);
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(1));
    act(() => announceLearningUndone(["own_platform_update_preference"]));
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(2));
  });
});

describe("chapter space notifications re-read after an undo", () => {
  it("loads the channel controls again", async () => {
    const api = { load: vi.fn().mockResolvedValue({}), heartbeat: vi.fn().mockResolvedValue(null) };
    renderHook(() => useChannelControls(api, "scope"));
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    act(() => announceLearningUndone(["own_channel_notifications"]));
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));
  });
});
