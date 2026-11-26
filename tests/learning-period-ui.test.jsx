import fs from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { learningPeriodCatalogue, learningPeriodT } from "../src/lib/i18n/learningPeriod.js";
import { createDemoLearningPeriodApi, createLearningPeriodApi, demoLearningFixture, withoutOrganizationControls } from "../src/features/learningPeriod/api.js";
import {
  bannerState, entryStatus, formatPeriodWhen, kindText, normalizeHistory, practiceBadge, undoChain, undoRefusalReason, undoSummary,
} from "../src/features/learningPeriod/model.js";
import {
  LearningPeriodAdminCard, LearningPeriodBanner, LearningPeriodProvider, PracticeBadge, PracticeHistorySettingsEntry,
  PracticeMarker, learningToastAction, useLearningPeriodController,
} from "../src/features/learningPeriod/LearningPeriod.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

// REQ-UG-LEARNING-PERIOD-BANNER-HISTORY-UNDO-UI-20261103 (#6947):
// the banner, the practice history with Undo, the administrator's start and
// end controls and the Practice badge, against the engine's RPC shapes.
afterEach(cleanup);

const NOW = Date.parse("2026-11-04T15:00:00Z");
const en = (key, vars) => learningPeriodT("en", key, vars);
const es = (key, vars) => learningPeriodT("es", key, vars);
const DAY = 24 * 60 * 60 * 1000;

function row(id, actionKind, extra = {}) {
  return {
    id, actionKind, domain: "tasks", disposition: "reverse", targetTable: "public.chapter_tasks", targetId: "task-a",
    parentEntryId: null, state: "active", version: 1, createdAt: "2026-11-04T14:00:00Z", undoneAt: null, keptAt: null,
    sent: false, undoable: true, ...extra,
  };
}

function Harness({ api, flags = null, children, onNotice = vi.fn() }) {
  const controller = useLearningPeriodController({ api, flags });
  return <LearningPeriodProvider value={controller} onNotice={onNotice}>{children(controller)}</LearningPeriodProvider>;
}

function mount(api, children, { lang = "en", flags = null, onNotice = vi.fn() } = {}) {
  return render(<LanguageProvider lang={lang}><Harness api={api} flags={flags} onNotice={onNotice}>{children}</Harness></LanguageProvider>);
}

function fakeApi({ period, entries = [], running = true, undo = null } = {}) {
  return {
    period: vi.fn().mockResolvedValue(period),
    start: vi.fn(),
    endEarly: vi.fn(),
    history: vi.fn().mockResolvedValue({ running, entries: normalizeHistory({ entries }).entries }),
    undo: undo ?? vi.fn().mockResolvedValue({ status: "undone", undoneCount: 1 }),
  };
}

function runningPeriod(extra = {}) {
  return { organizationId: "org", used: true, running: true, periodId: "p", lengthDays: 14, startsAt: new Date(Date.now() - DAY).toISOString(),
    endsAt: new Date(Date.now() + 9 * DAY).toISOString(), endedEarlyAt: null, closedAt: null, endAt: new Date(Date.now() + 9 * DAY).toISOString(), isAdmin: false, ...extra };
}

describe("learning period model", () => {
  it("gives every line one honest status", () => {
    const running = { running: true };
    expect(entryStatus(row("1", "task_edit"), running)).toEqual({ status: "available", reasonKey: null });
    expect(entryStatus(row("1", "task_edit", { state: "undone", undoable: false }), running).status).toBe("undone");
    expect(entryStatus(row("1", "task_comment", { disposition: "permanent", state: "kept", undoable: false }), running).status).toBe("sent");
    expect(entryStatus(row("1", "task_file_remove", { disposition: "permanent", state: "kept", undoable: false }), running).status).toBe("final");
    expect(entryStatus(row("1", "task_template_update", { disposition: "permanent", state: "kept", undoable: false }), running).status).toBe("kept");
    expect(entryStatus(row("1", "task_edit", { state: "kept", undoable: false }), { running: false }).status).toBe("kept");
    expect(entryStatus(row("1", "learning_action_undo", { disposition: "excluded", undoable: false }), running))
      .toEqual({ status: "refused", reasonKey: "learningPeriod.reason.excluded" });
    expect(entryStatus(row("1", "task_edit"), { running: false })).toEqual({ status: "refused", reasonKey: "learningPeriod.reason.ended" });
    expect(entryStatus(row("1", "task_edit"), { running: true, refusals: new Map([["1", "learningPeriod.reason.changedByOther"]]) }))
      .toEqual({ status: "refused", reasonKey: "learningPeriod.reason.changedByOther" });
  });

  it("builds the server's newest-first chain and lists what stays sent", () => {
    const entries = normalizeHistory({ entries: [
      row("e3", "task_move", { createdAt: "2026-11-04T14:03:00Z" }),
      row("s1", "task_message", { disposition: "permanent", state: "kept", createdAt: "2026-11-04T14:02:30Z", undoable: false }),
      row("e2", "task_edit", { createdAt: "2026-11-04T14:02:00Z" }),
      row("e1", "task_create", { createdAt: "2026-11-04T14:01:00Z" }),
      row("x", "task_edit", { targetId: "task-b", createdAt: "2026-11-04T14:04:00Z" }),
      row("gone", "task_edit", { state: "undone", createdAt: "2026-11-04T14:05:00Z" }),
    ] }).entries;
    expect(undoChain("e1", entries).map((entry) => entry.id)).toEqual(["e3", "e2", "e1"]);
    const summary = undoSummary("e1", entries);
    expect(summary.laterSteps).toBe(2);
    expect(summary.staysSent.map((entry) => entry.id)).toEqual(["s1"]);
    expect(undoSummary("e3", entries)).toEqual({ laterSteps: 0, staysSent: [] });
  });

  it("joins a whole bulk action, parent and children", () => {
    const entries = normalizeHistory({ entries: [
      row("parent", "task_edit", { targetId: "bulk" }),
      row("child-1", "task_edit", { targetId: "t1", parentEntryId: "parent" }),
      row("child-2", "task_edit", { targetId: "t2", parentEntryId: "parent" }),
    ] }).entries;
    expect(undoChain("child-1", entries).map((entry) => entry.id).sort()).toEqual(["child-1", "child-2", "parent"]);
  });

  it("reads the engine's refusals as reasons", () => {
    expect(undoRefusalReason({ code: "40001", message: "someone else has changed this since" })).toBe("learningPeriod.reason.changedByOther");
    expect(undoRefusalReason({ code: "40001", message: "this has changed since your practice action" })).toBe("learningPeriod.reason.changed");
    expect(undoRefusalReason({ code: "40001", message: "learning entry changed" })).toBe("learningPeriod.reason.stale");
    expect(undoRefusalReason({ code: "55000", message: "the learning period has ended" })).toBe("learningPeriod.reason.ended");
    expect(undoRefusalReason({ code: "55000", message: "this practice action can no longer be undone" })).toBe("learningPeriod.reason.noLonger");
    expect(undoRefusalReason({ code: "42501", message: "authentication required" })).toBe("learningPeriod.reason.notAllowed");
    expect(undoRefusalReason(new Error("Failed to fetch"))).toBe("learningPeriod.reason.failed");
  });

  it("keeps the Practice badge on created items after the end and drops edit markers", () => {
    expect(practiceBadge("practice", { running: true })?.labelKey).toBe("learningPeriod.badge.practice");
    expect(practiceBadge("practice", { running: false })?.labelKey).toBe("learningPeriod.badge.practice");
    expect(practiceBadge("practice_edit", { running: true })?.labelKey).toBe("learningPeriod.badge.edit");
    expect(practiceBadge("practice_edit", { running: true, mine: true })?.labelKey).toBe("learningPeriod.badge.editMine");
    expect(practiceBadge("practice_edit", { running: false })).toBeNull();
    expect(practiceBadge(null, { running: true })).toBeNull();
  });

  // #7649, #7654 and #7661: the end is Eastern even when the caller passes
  // no zone. Daylight time still moves the clock. The label is the literal
  // ET. An explicit non-Eastern zone is not labeled ET.
  it("states the end in Eastern time", () => {
    expect(formatPeriodWhen("2026-11-17T14:14:00Z", "en", en)).toBe("Tuesday, November 17 at 9:14 AM ET");
    expect(formatPeriodWhen("2026-11-17T14:14:00Z", "en", en, "America/New_York")).toBe("Tuesday, November 17 at 9:14 AM ET");
    expect(formatPeriodWhen("2026-07-17T14:14:00Z", "en", en)).toBe("Friday, July 17 at 10:14 AM ET");
    expect(formatPeriodWhen("2026-11-17T14:14:00Z", "es", es)).toBe("martes, 17 de noviembre a las 9:14 a. m. ET");
    expect(formatPeriodWhen("2026-11-17T14:14:00Z", "en", en, "America/Los_Angeles")).toBe("Tuesday, November 17 at 6:14 AM");
    expect(formatPeriodWhen("nonsense", "en", en)).toBe("");
  });

  it("shows the ended line for two weeks only", () => {
    const ended = { used: true, running: false, endAt: new Date(NOW - DAY).toISOString(), closedAt: new Date(NOW - DAY).toISOString() };
    expect(bannerState(ended, NOW)?.phase).toBe("ended");
    expect(bannerState(ended, NOW + 20 * DAY)).toBeNull();
    expect(bannerState({ used: false }, NOW)).toBeNull();
    expect(bannerState({ used: true, running: true, endAt: new Date(NOW - 1000).toISOString() }, NOW)?.phase).toBe("ended");
  });


  // Every kind the migrations register in the exports, automations and
  // case-access domains has its own line in both languages, so none of them
  // reads by its domain or as "A practice action in Union Ground".
  it("names every export, automation and case-access kind the engine registers", () => {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const kinds = new Map();
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of sql.matchAll(/\(\s*'([a-z_]+)',\s*'(exports|automations|case_access)',\s*'(?:reverse|permanent)'/g)) kinds.set(match[1], match[2]);
    }
    expect([...kinds.values()].filter((d) => d === "exports").length).toBeGreaterThanOrEqual(8);
    expect([...kinds.values()].filter((d) => d === "automations").length).toBeGreaterThanOrEqual(3);
    expect([...kinds.values()].filter((d) => d === "case_access").length).toBeGreaterThanOrEqual(8);
    for (const [actionKind, domain] of kinds) {
      for (const t of [en, es]) {
        const line = kindText({ actionKind, domain }, t);
        expect(line, `${actionKind} has its own line`).toBe(t(`learningPeriod.kind.${actionKind}`));
        expect(line).not.toBe(t("learningPeriod.kind.fallback", { domain: t(`learningPeriod.domain.${domain}`) }));
        expect(t(`learningPeriod.domain.${domain}`)).not.toBe(`learningPeriod.domain.${domain}`);
      }
    }
  });
});

describe("learning period client", () => {
  it("calls the engine's RPCs with their own argument names", async () => {
    const rpc = vi.fn(async (name) => ({ data: name === "undo_my_learning_action" ? { status: "undone", undoneCount: 3 }
      : name === "list_my_learning_history" ? { running: true, entries: [row("1", "task_edit")] } : { used: false }, error: null }));
    const api = createLearningPeriodApi({ rpc });
    await api.period();
    await api.start(7);
    await api.start(30);
    await api.endEarly();
    await api.history("2026-11-04T00:00:00Z");
    await expect(api.undo("entry", 4)).resolves.toEqual({ status: "undone", undoneCount: 3 });
    expect(rpc.mock.calls).toEqual([
      ["get_organization_learning_period", {}],
      ["start_organization_learning_period", { p_length_days: 7 }],
      ["start_organization_learning_period", { p_length_days: 14 }],
      ["end_organization_learning_period_early", {}],
      ["list_my_learning_history", { p_limit: 50, p_before: "2026-11-04T00:00:00Z" }],
      ["undo_my_learning_action", { p_entry_id: "entry", p_expected_version: 4 }],
    ]);
  });

  it("keeps the server's code and message on a refusal", async () => {
    const api = createLearningPeriodApi({ rpc: async () => ({ data: null, error: { code: "40001", message: "someone else has changed this since" } }) });
    await expect(api.undo("entry", 1)).rejects.toMatchObject({ code: "40001", message: "someone else has changed this since" });
  });
});

describe("learning period screens", () => {
  it("shows the banner with the end, the history link and End early for an administrator", async () => {
    const api = fakeApi({ period: runningPeriod({ isAdmin: true }) });
    mount(api, () => <LearningPeriodBanner />);
    const banner = await screen.findByRole("region", { name: "Learning period" });
    expect(within(banner).getByText(/^Learning period ends /)).toBeTruthy();
    expect(within(banner).getByText(/ ET/)).toBeTruthy();
    expect(within(banner).getByText(/Undo never unsends anything that already went out/)).toBeTruthy();
    expect(within(banner).getByRole("button", { name: "Your practice history" })).toBeTruthy();
    expect(within(banner).getByRole("button", { name: "End early" })).toBeTruthy();
  });

  it("gives a member no End early and nothing when the period was never used", async () => {
    const api = fakeApi({ period: runningPeriod() });
    mount(api, () => <LearningPeriodBanner />);
    await screen.findByRole("region", { name: "Learning period" });
    expect(screen.queryByRole("button", { name: "End early" })).toBeNull();
    cleanup();
    mount(fakeApi({ period: { used: false, running: false, isAdmin: true } }), () => <LearningPeriodBanner />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Learning period" })).toBeNull());
  });

  // #8782: the end of a running period reads the period again.
  it.each([
    ["held", null, null],
    ["released", "ended", "Your practice history"],
  ])("reads the period again when it ends with the offer %s", async (_offer, phase, historyName) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const endAt = new Date(Date.now() + 60 * 1000).toISOString();
      const running = runningPeriod({ endsAt: endAt, endAt });
      const afterEnd = phase ? { ...running, running: false, closedAt: endAt } : null;
      const api = fakeApi({ period: running });
      api.period.mockResolvedValueOnce(running).mockResolvedValue(afterEnd);
      mount(api, () => <LearningPeriodBanner />);
      await vi.waitFor(() => expect(screen.getByRole("region", { name: "Learning period" }).dataset.phase).toBe("running"));
      expect(api.period).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await vi.waitFor(() => expect(api.period).toHaveBeenCalledTimes(2));
      if (phase) {
        await vi.waitFor(() => expect(screen.getByRole("region", { name: "Learning period" }).dataset.phase).toBe(phase));
        expect(within(screen.getByRole("region", { name: "Learning period" })).getByRole("button", { name: historyName })).toBeTruthy();
      } else {
        await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Learning period" })).toBeNull());
      }
      // One read at the end, not a loop.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(api.period).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A device clock ahead of the server reads the
  // period at its end while the server still says it runs; one more read a
  // short time later settles it, and only one.
  it("reads the period once more a minute later when the read at the end still says it runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const endAt = new Date(Date.now() + 60 * 1000).toISOString();
      const running = runningPeriod({ endsAt: endAt, endAt });
      const api = fakeApi({ period: running });
      // First load and the read at the end both say running (the server's
      // clock is behind); the late read finds the held period gone.
      api.period.mockResolvedValueOnce(running).mockResolvedValueOnce({ ...running }).mockResolvedValue(null);
      mount(api, () => <LearningPeriodBanner />);
      await vi.waitFor(() => expect(screen.getByRole("region", { name: "Learning period" }).dataset.phase).toBe("running"));
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await vi.waitFor(() => expect(api.period).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("region", { name: "Learning period" })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await vi.waitFor(() => expect(api.period).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Learning period" })).toBeNull());
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(api.period).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // A client rebuilt inside the minute after an early read
  // (a token renewal) cancels that late read, and schedules its own.
  it("schedules the late read again when the client is rebuilt inside that minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const endAt = new Date(Date.now() + 60 * 1000).toISOString();
      const running = runningPeriod({ endsAt: endAt, endAt });
      const first = fakeApi({ period: running });
      first.period.mockImplementation(async () => ({ ...running }));
      const view = mount(first, () => <LearningPeriodBanner />);
      await vi.waitFor(() => expect(screen.getByRole("region", { name: "Learning period" }).dataset.phase).toBe("running"));
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await vi.waitFor(() => expect(first.period).toHaveBeenCalledTimes(2));
      // The renewed client still reads the period as running, then it is gone.
      const renewed = fakeApi({ period: running });
      renewed.period.mockResolvedValueOnce({ ...running }).mockResolvedValue(null);
      view.rerender(<LanguageProvider lang="en"><Harness api={renewed}>{() => <LearningPeriodBanner />}</Harness></LanguageProvider>);
      await vi.waitFor(() => expect(renewed.period).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await vi.waitFor(() => expect(renewed.period).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Learning period" })).toBeNull());
      expect(first.period).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the period only once more when the server keeps saying it runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const endAt = new Date(Date.now() + 60 * 1000).toISOString();
      const running = runningPeriod({ endsAt: endAt, endAt });
      const api = fakeApi({ period: running });
      api.period.mockImplementation(async () => ({ ...running }));
      mount(api, () => <LearningPeriodBanner />);
      await vi.waitFor(() => expect(screen.getByRole("region", { name: "Learning period" }).dataset.phase).toBe("running"));
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await vi.waitFor(() => expect(api.period).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await vi.waitFor(() => expect(api.period).toHaveBeenCalledTimes(3));
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(api.period).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends early only after the one-way confirmation", async () => {
    const api = fakeApi({ period: runningPeriod({ isAdmin: true }) });
    api.endEarly.mockResolvedValue({ ...runningPeriod({ isAdmin: true }), running: false });
    const onNotice = vi.fn();
    mount(api, () => <LearningPeriodBanner onNotice={onNotice} />, { onNotice });
    fireEvent.click(await screen.findByRole("button", { name: "End early" }));
    expect(api.endEarly).not.toHaveBeenCalled();
    expect(screen.getByText(/Ending cannot be reversed, and the period cannot be started again/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "End the learning period" }).at(-1));
    await waitFor(() => expect(api.endEarly).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("The learning period has ended. Everything done during it is kept."));
  });

  it("offers an administrator 7 or 14 days, 14 by default, with the honest promise", async () => {
    const api = fakeApi({ period: { used: false, running: false, isAdmin: true } });
    api.start.mockResolvedValue(runningPeriod({ isAdmin: true }));
    mount(api, () => <LearningPeriodAdminCard />);
    expect(await screen.findByRole("heading", { name: "Start a learning period" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "14 days (recommended)" }).checked).toBe(true);
    expect(screen.getByText(/does not unsend anything that already went out/)).toBeTruthy();
    expect(screen.getByText(/People who join later do not get a separate period/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Start the learning period" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith(7));
  });

  it("shows no administrator card to a member", async () => {
    const api = fakeApi({ period: { used: false, running: false, isAdmin: false } });
    mount(api, () => <LearningPeriodAdminCard />);
    await waitFor(() => expect(api.period).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Start a learning period" })).toBeNull();
  });

  it("lists available, refused, undone, sent and final lines and confirms the chain", async () => {
    const entries = [
      row("e3", "task_move", { createdAt: "2026-11-04T14:03:00Z" }),
      row("s1", "task_message", { disposition: "permanent", state: "kept", sent: true, undoable: false, targetTable: "public.chapter_tasks", createdAt: "2026-11-04T14:02:30Z" }),
      row("e2", "task_edit", { createdAt: "2026-11-04T14:02:00Z" }),
      row("e1", "task_create", { createdAt: "2026-11-04T14:01:00Z" }),
      row("f1", "task_file_remove", { disposition: "permanent", state: "kept", undoable: false, targetTable: "public.chapter_task_files", createdAt: "2026-11-04T13:00:00Z" }),
      row("u1", "task_create", { targetId: "task-z", state: "undone", undoable: false, createdAt: "2026-11-04T12:00:00Z" }),
    ];
    const api = fakeApi({ period: runningPeriod(), entries });
    mount(api, () => <PracticeHistorySettingsEntry />);
    fireEvent.click(await screen.findByRole("button", { name: "Your practice history" }));
    const dialog = await screen.findByRole("dialog", { name: "Your practice history" });
    await within(dialog).findByText("Moved a task");
    expect(within(dialog).getByText(/does not unsend anything that already went out/)).toBeTruthy();
    expect(within(dialog).getByText("Records you undo are hidden, not erased.")).toBeTruthy();
    const line = (id) => dialog.querySelector(`[data-entry-id="${id}"]`);
    expect(line("s1").dataset.status).toBe("sent");
    expect(within(line("s1")).getByText("This went out and stays sent. Undo cannot recall it.")).toBeTruthy();
    expect(line("f1").dataset.status).toBe("final");
    expect(line("u1").dataset.status).toBe("undone");
    expect(within(line("u1")).getByText("You undid this. It is hidden, not erased.")).toBeTruthy();
    expect(within(line("u1")).queryByRole("button", { name: /Undo/ })).toBeNull();
    fireEvent.click(within(line("e1")).getByRole("button", { name: "Undo: Created a task" }));
    const confirm = within(line("e1")).getByRole("group", { name: "Undo this practice action?" });
    expect(within(confirm).getByText("This also undoes 2 later steps you took.")).toBeTruthy();
    expect(within(confirm).getByText("Sent a task message: stays sent")).toBeTruthy();
    expect(api.undo).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith("e1", 1));
  });

  it("shows the server's refusal on the line and keeps it active", async () => {
    const undo = vi.fn().mockRejectedValue(Object.assign(new Error("someone else has changed this since"), { code: "40001" }));
    const api = fakeApi({ period: runningPeriod(), entries: [row("e1", "task_edit")], undo });
    mount(api, (controller) => <button type="button" onClick={controller.openHistory}>open</button>);
    fireEvent.click(await screen.findByRole("button", { name: "open" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Undo: Edited a task" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(dialog.querySelector('[data-entry-id="e1"]').dataset.status).toBe("refused"));
    expect(within(dialog).getAllByText(/Someone else has changed this since/).length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("button", { name: "Undo: Edited a task" })).toBeNull();
  });

  it("pages to older actions and recovers from a failed read", async () => {
    const page = Array.from({ length: 50 }, (_, index) => row(`p${index}`, "task_edit", { targetId: `t${index}`, createdAt: new Date(Date.UTC(2026, 10, 4, 14, 0, 50 - index)).toISOString() }));
    const api = fakeApi({ period: runningPeriod() });
    api.history = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ running: true, entries: normalizeHistory({ entries: page }).entries })
      .mockResolvedValueOnce({ running: true, entries: normalizeHistory({ entries: [row("old", "task_create", { createdAt: "2026-11-01T10:00:00Z" })] }).entries });
    mount(api, (controller) => <button type="button" onClick={controller.openHistory}>open</button>);
    fireEvent.click(await screen.findByRole("button", { name: "open" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Your practice history could not be loaded.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Show older actions" }));
    expect(await within(dialog).findByText("Created a task")).toBeTruthy();
    expect(api.history).toHaveBeenLastCalledWith(page.at(-1).createdAt);
    expect(within(dialog).queryByRole("button", { name: "Show older actions" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
  });

  it("says why a start failed and keeps the offer", async () => {
    const api = fakeApi({ period: { used: false, running: false, isAdmin: true } });
    api.start.mockRejectedValue(Object.assign(new Error("admin role with verified sign-in required"), { code: "42501" }));
    mount(api, () => <LearningPeriodAdminCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Start the learning period" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The learning period could not be started. Check that you signed in with two-step verification, then try again.");
    expect(api.start).toHaveBeenCalledWith(14);
  });

  it("says already undone when the server says so", async () => {
    const undo = vi.fn().mockResolvedValue({ status: "already_undone", undoneCount: 0 });
    const api = fakeApi({ period: runningPeriod(), entries: [row("e1", "task_edit")], undo });
    mount(api, (controller) => <button type="button" onClick={controller.openHistory}>open</button>);
    fireEvent.click(await screen.findByRole("button", { name: "open" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Undo: Edited a task" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(await within(dialog).findByText("This was already undone.")).toBeTruthy();
  });

  it("reads Kept and Undone without Undo after the end", async () => {
    const ended = runningPeriod({ running: false, endsAt: new Date(Date.now() - DAY).toISOString(), endAt: new Date(Date.now() - DAY).toISOString(), closedAt: new Date(Date.now() - DAY).toISOString() });
    const entries = [row("k1", "task_edit", { state: "kept", undoable: false }), row("u1", "task_create", { state: "undone", undoable: false })];
    const api = fakeApi({ period: ended, entries, running: false });
    mount(api, () => <PracticeHistorySettingsEntry />);
    expect(await screen.findByText(/These lines show what was kept and what you undid/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Your practice history" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Edited a task");
    expect(dialog.querySelector('[data-entry-id="k1"]').dataset.status).toBe("kept");
    expect(dialog.querySelector('[data-entry-id="u1"]').dataset.status).toBe("undone");
    expect(within(dialog).queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("marks practice records for other members, and keeps created items marked after the end", async () => {
    const flags = new Map([["public.chapter_tasks:a", "practice"], ["public.chapter_tasks:b", "practice_edit"]]);
    mount(fakeApi({ period: runningPeriod() }), () => <>
      <div data-testid="a"><PracticeMarker table="public.chapter_tasks" id="a" /></div>
      <div data-testid="b"><PracticeMarker table="public.chapter_tasks" id="b" /></div>
      <div data-testid="c"><PracticeMarker table="public.chapter_tasks" id="c" /></div>
    </>, { flags });
    await waitFor(() => expect(within(screen.getByTestId("b")).getByText("Practice change")).toBeTruthy());
    expect(within(screen.getByTestId("a")).getByText("Practice")).toBeTruthy();
    expect(screen.getByTestId("c").textContent).toBe("");
    cleanup();
    const ended = runningPeriod({ running: false, endAt: new Date(Date.now() - DAY).toISOString() });
    mount(fakeApi({ period: ended }), () => <>
      <div data-testid="a"><PracticeMarker table="public.chapter_tasks" id="a" /></div>
      <div data-testid="b"><PracticeMarker table="public.chapter_tasks" id="b" /></div>
      <PracticeBadge flag="practice_edit" />
    </>, { flags });
    await waitFor(() => expect(within(screen.getByTestId("a")).getByText("Practice")).toBeTruthy());
    expect(screen.getByTestId("b").textContent).toBe("");
  });

  it("puts the practice history on a write's toast only while the period runs", () => {
    const t = (key) => key;
    const openHistory = vi.fn();
    const action = learningToastAction({ running: true, openHistory }, t);
    expect(action.label).toBe("learningPeriod.openHistory");
    action.run();
    expect(openHistory).toHaveBeenCalled();
    expect(learningToastAction({ running: false, openHistory }, t)).toBeNull();
    expect(learningToastAction(null, t)).toBeNull();
  });

  it("speaks Spanish on every surface", async () => {
    const api = fakeApi({ period: runningPeriod({ isAdmin: true }), entries: [row("e1", "task_edit")] });
    mount(api, () => <><LearningPeriodBanner /><LearningPeriodAdminCard /></>, { lang: "es" });
    const [banner] = await screen.findAllByRole("region", { name: "Período de aprendizaje" });
    expect(within(banner).getByText(/^El período de aprendizaje termina el /)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Terminar antes" }).length).toBe(2);
    fireEvent.click(within(banner).getByRole("button", { name: "Tu historial de práctica" }));
    expect(await screen.findByText("Editaste una tarea")).toBeTruthy();
  });

  it("walks the fixture twin through undo and end early", async () => {
    const api = createDemoLearningPeriodApi(demoLearningFixture(NOW, { taskIds: ["t1", "t2"] }));
    const before = await api.history();
    const create = before.entries.find((entry) => entry.actionKind === "task_create" && entry.state === "active");
    await expect(api.undo(create.id, create.version)).resolves.toEqual({ status: "undone", undoneCount: 3 });
    await expect(api.undo(create.id, create.version)).resolves.toMatchObject({ status: "already_undone" });
    await api.endEarly();
    const after = await api.history();
    expect(after.running).toBe(false);
    expect(after.entries.every((entry) => entry.state !== "active")).toBe(true);
    await expect(api.endEarly()).rejects.toMatchObject({ code: "55000" });
    await expect(api.undo("00000000-0000-4000-8000-000000000005", 1)).rejects.toMatchObject({ message: "the learning period has ended" });
    await expect(api.undo("missing", 1)).rejects.toMatchObject({ code: "P0002" });
  });

  it("refuses a stale version and a second start in the fixture twin, and starts an unused one", async () => {
    const api = createDemoLearningPeriodApi(demoLearningFixture(NOW));
    const [latest] = (await api.history()).entries;
    await expect(api.undo(latest.id, latest.version + 1)).rejects.toMatchObject({ code: "40001", message: "learning entry changed" });
    await expect(api.start(14)).rejects.toMatchObject({ code: "55000" });
    const fresh = demoLearningFixture(NOW, { isAdmin: true });
    fresh.period = { ...fresh.period, used: false, running: false };
    const unused = createDemoLearningPeriodApi(fresh);
    expect((await unused.period()).used).toBe(false);
    const started = await unused.start(7);
    expect(started).toMatchObject({ used: true, running: true, lengthDays: 7 });
    expect(Date.parse(started.endsAt) - Date.parse(started.startsAt)).toBe(7 * DAY);
  });

  it("refuses an unreadable server answer instead of guessing", async () => {
    const api = createLearningPeriodApi({ rpc: async () => ({ data: { status: 7 }, error: null }) });
    await expect(api.undo("entry", 1)).rejects.toMatchObject({ message: "learning period response unreadable", code: null });
    const history = createLearningPeriodApi({ rpc: async () => ({ data: { entries: "no" }, error: null }) });
    await expect(history.history()).rejects.toMatchObject({ message: "learning period response unreadable" });
  });
});

describe("learning period copy", () => {
  it("has a Spanish line for every English key", () => {
    expect(Object.keys(learningPeriodCatalogue.es).sort()).toEqual(Object.keys(learningPeriodCatalogue.en).sort());
  });

  it("never says undo erases history or recalls what was sent", () => {
    // Any sentence that talks about erasing, wiping, recalling or unsending
    // must deny it in the same sentence.
    for (const lang of ["en", "es"]) {
      for (const text of Object.values(learningPeriodCatalogue[lang])) {
        for (const sentence of text.split(/(?<=[.:?])\s+/)) {
          if (/\b(eras|wip|recall|unsend|borra|recuper|anula el envío)/i.test(sentence)) {
            expect(sentence, sentence).toMatch(/\b(not|never|cannot|no|nunca)\b/i);
          }
        }
      }
    }
    expect(learningPeriodCatalogue.en["learningPeriod.promise"]).toMatch(/does not unsend/);
    expect(learningPeriodCatalogue.en["learningPeriod.promise"]).toMatch(/keeps its normal record/);
    expect(learningPeriodCatalogue.en["learningPeriod.hiddenNotErased"]).toBe("Records you undo are hidden, not erased.");
  });
});

// UX-UG-DEMO-ADMIN-OPENS-ON-ONE-TIME-LEARNING-PERIOD-20261108: the
// shared demo organization's one-time period is read as a member reads it,
// so the Admin desk opens on its work and no visitor can start or end it.
describe("learning period in the shared demo", () => {
  it("shows a demo administrator no offer card and no End early", async () => {
    const unused = fakeApi({ period: { used: false, running: false, isAdmin: true } });
    mount(withoutOrganizationControls(unused), () => <LearningPeriodAdminCard />);
    await waitFor(() => expect(unused.period).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Start a learning period" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start the learning period" })).toBeNull();
    cleanup();

    const running = fakeApi({ period: runningPeriod({ isAdmin: true }) });
    mount(withoutOrganizationControls(running), () => <><LearningPeriodBanner /><LearningPeriodAdminCard /></>);
    const banner = await screen.findByRole("region", { name: "Learning period" });
    expect(within(banner).getByRole("button", { name: "Your practice history" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End early" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Learning period" })).toBeNull();
  });

  it("refuses a start or an end before any request and passes member reads through", async () => {
    const api = fakeApi({ period: runningPeriod({ isAdmin: true }), entries: [row("e1", "task_create")] });
    const demo = withoutOrganizationControls(api);
    await expect(demo.start(14)).rejects.toMatchObject({ code: "shared-demo-account" });
    await expect(demo.endEarly()).rejects.toMatchObject({ code: "shared-demo-account" });
    expect(api.start).not.toHaveBeenCalled();
    expect(api.endEarly).not.toHaveBeenCalled();
    expect(await demo.period()).toMatchObject({ running: true, isAdmin: false });
    expect((await demo.history()).entries).toHaveLength(1);
    await demo.undo("e1", 1);
    expect(api.undo).toHaveBeenCalledWith("e1", 1);
    expect(Object.keys(demo).sort()).toEqual(["endEarly", "history", "period", "start", "undo"]);
    expect(withoutOrganizationControls(null)).toBeNull();
    api.period.mockResolvedValue(null);
    expect(await demo.period()).toBeNull();
  });

  // REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112 (#8581):
  // while the period is held the server answers the read with null.
  it("draws no banner, offer, Start or Settings entry when the server answers the period read with null", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const { container } = mount(createLearningPeriodApi({ rpc }), () => <><LearningPeriodBanner /><LearningPeriodAdminCard /><PracticeHistorySettingsEntry /></>);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("get_organization_learning_period", {}));
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByRole("button")).toBeNull();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["get_organization_learning_period"]);
  });

  it("keeps a real organization's administrator offer", async () => {
    const api = fakeApi({ period: { used: false, running: false, isAdmin: true } });
    mount(api, () => <LearningPeriodAdminCard />);
    expect(await screen.findByRole("heading", { name: "Start a learning period" })).toBeTruthy();
  });

  it("wraps the client only for the shared SAMPLE persona session, and draws no fixture period while the period is held", () => {
    const app = fs.readFileSync(path.join(import.meta.dirname, "../src/App.jsx"), "utf8");
    // REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112 (#8581).
    expect(app).toContain("if (fixtureDemo) return { api: null, flags: null };");
    expect(app).not.toMatch(/createDemoLearningPeriodApi|demoLearningFixture/);
    expect(app).toMatch(/sharedPersonaSession \? withoutOrganizationControls\(api\) : api/);
    expect(app).toMatch(/const sharedPersonaSession = sampleLive && personaRouting;/);
  });
});

// Ending early, starting and undoing keep focus while their write
// runs, and a second activation in the same tick sends nothing more.
describe("learning period writes while one runs", () => {
  const openEnd = async (api) => {
    mount(api, () => <LearningPeriodBanner onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "End early" }));
    return screen.getAllByRole("button", { name: "End the learning period" }).at(-1);
  };

  it("ends once when End the learning period is activated twice in one tick", async () => {
    const api = fakeApi({ period: runningPeriod({ isAdmin: true }) });
    api.endEarly.mockImplementation(async () => ({ ...runningPeriod({ isAdmin: true }), running: false }));
    const end = await openEnd(api);
    await expectOneWriteFromOneTick(api.endEarly, [() => fireEvent.click(end), () => fireEvent.click(end)]);
  });

  const openStart = async (api) => {
    mount(api, () => <LearningPeriodAdminCard />);
    await screen.findByRole("heading", { name: "Start a learning period" });
    return screen.getByRole("button", { name: "Start the learning period" });
  };

  it("keeps Start the learning period focused while it starts, and starts once", async () => {
    const api = fakeApi({ period: { used: false, running: false, isAdmin: true } });
    api.start.mockImplementation(async () => runningPeriod({ isAdmin: true }));
    await expectHeldWriteFocus(api.start, await openStart(api));
    expect(api.start).toHaveBeenCalledExactlyOnceWith(14);
  });

  it("starts once when Start the learning period is activated twice in one tick", async () => {
    const api = fakeApi({ period: { used: false, running: false, isAdmin: true } });
    api.start.mockImplementation(async () => runningPeriod({ isAdmin: true }));
    const start = await openStart(api);
    await expectOneWriteFromOneTick(api.start, [() => fireEvent.click(start), () => fireEvent.click(start)]);
  });

  const openUndo = async (api) => {
    mount(api, (controller) => <button type="button" onClick={controller.openHistory}>open</button>);
    fireEvent.click(await screen.findByRole("button", { name: "open" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Undo: Edited a task" }));
    return within(dialog).getByRole("button", { name: "Undo" });
  };

  it("keeps the confirmed Undo focused while it undoes, and undoes once", async () => {
    const undo = vi.fn(async () => ({ status: "undone", undoneCount: 1 }));
    const api = fakeApi({ period: runningPeriod(), entries: [row("e1", "task_edit")], undo });
    await expectHeldWriteFocus(undo, await openUndo(api));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  // #8969 review P1: the undo lock ends with the write. While the history reload
  // after a finished Undo is still held, a second, ready Undo is sent.
  it("sends a ready second Undo while the first undo's history reload is held", async () => {
    const entries = [row("a", "task_edit", { targetId: "task-a", createdAt: "2026-11-04T14:00:00Z" }), row("b", "task_edit", { targetId: "task-b", createdAt: "2026-11-04T14:01:00Z" })];
    let releaseReload;
    const reload = new Promise((resolve) => { releaseReload = resolve; });
    const api = {
      history: vi.fn().mockResolvedValueOnce({ running: true, entries: normalizeHistory({ entries }).entries }).mockImplementation(() => reload),
      undo: vi.fn(async () => ({ status: "undone", undoneCount: 1 })),
    };
    render(<LanguageProvider lang="en"><LearningPeriodProvider value={{ api, running: true, historyOpen: true, closeHistory: vi.fn(), refresh: vi.fn() }} /></LanguageProvider>);
    const dialog = await screen.findByRole("dialog");
    const choose = (id) => {
      const line = dialog.querySelector(`[data-entry-id="${id}"]`);
      fireEvent.click(within(line).getByRole("button", { name: "Undo: Edited a task" }));
      return within(line).getByRole("button", { name: "Undo", exact: true });
    };
    fireEvent.click(choose("a"));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
    expect(api.undo).toHaveBeenCalledExactlyOnceWith("a", 1);
    const second = choose("b");
    expect(second).toBeEnabled();
    expect(second).not.toHaveAttribute("aria-disabled");
    fireEvent.click(second);
    try {
      await act(async () => {});
      expect(api.undo).toHaveBeenCalledTimes(2);
      expect(api.undo).toHaveBeenLastCalledWith("b", 1);
    } finally {
      await act(async () => { releaseReload({ running: true, entries: normalizeHistory({ entries }).entries }); });
    }
  });

  it("undoes once when the confirmed Undo is activated twice in one tick", async () => {
    const undo = vi.fn(async () => ({ status: "undone", undoneCount: 1 }));
    const api = fakeApi({ period: runningPeriod(), entries: [row("e1", "task_edit")], undo });
    const confirm = await openUndo(api);
    await expectOneWriteFromOneTick(undo, [() => fireEvent.click(confirm), () => fireEvent.click(confirm)]);
  });
});

