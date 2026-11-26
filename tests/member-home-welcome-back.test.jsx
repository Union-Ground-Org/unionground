// REQ-UG-REACTIVATION-WELCOME-BACK-20261001: the web welcome-back screen.
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WELCOME_BACK_RPC, normalizeWelcomeBack, resolveWelcomeBackStep } from "../src/features/memberHome/welcomeBack.js";
import { WelcomeBackScreen, useWelcomeBack, welcomeBackInputs } from "../src/features/memberHome/WelcomeBack.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { catalogue } from "../src/lib/i18n.js";

const SWITCH = "features.home.reactivation_welcome_back";
const NOW = new Date(2026, 9, 1, 12);
const at = (days) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

function liveTransport(payload, error = null) {
  const rpc = vi.fn(async () => ({ data: payload, error }));
  return { rpc, transport: { createSessionClient: vi.fn(() => ({ rpc })), session: { access_token: "token-1" } } };
}

function member(overrides = {}) {
  return {
    organizationConfiguration: { switches: { [SWITCH]: true } },
    member: { id: "member-1", organizationId: "org-1", firstName: "Darnell", chapterId: "ch-1", notificationCount: 0 },
    broadcasts: [],
    planItems: [],
    events: [],
    cases: [],
    ...overrides,
  };
}

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("welcome-back model", () => {
  it("only trusts an enabled server answer", () => {
    expect(normalizeWelcomeBack(null)).toEqual({ enabled: false, welcomeBack: false, afterDays: null });
    expect(normalizeWelcomeBack({ enabled: false, welcomeBack: true })).toEqual({ enabled: false, welcomeBack: false, afterDays: null });
    expect(normalizeWelcomeBack({ enabled: true, welcomeBack: true, afterDays: 21 })).toEqual({ enabled: true, welcomeBack: true, afterDays: 21 });
  });

  it("picks one next step in the old order: updates, poll, event, case, resources", () => {
    const all = { unreadUpdates: 2, newestUpdateTitle: "Vote Friday", openPolls: [{ id: "p", title: "Poll" }], events: [{ id: "e", title: "Meeting", startsAt: at(2) }], activeCases: [{ id: "c", reference: "GR-1" }], now: NOW };
    expect(resolveWelcomeBackStep(all)).toEqual({ kind: "updates", count: 2, title: "Vote Friday" });
    expect(resolveWelcomeBackStep({ ...all, unreadUpdates: 0 })).toEqual({ kind: "poll", id: "p", title: "Poll" });
    expect(resolveWelcomeBackStep({ ...all, unreadUpdates: 0, openPolls: [] })).toMatchObject({ kind: "event", id: "e", title: "Meeting" });
    expect(resolveWelcomeBackStep({ ...all, unreadUpdates: 0, openPolls: [], events: [{ id: "old", title: "Past", startsAt: at(-1) }] })).toMatchObject({ kind: "case", id: "c", reference: "GR-1" });
    expect(resolveWelcomeBackStep({ now: NOW })).toEqual({ kind: "resources" });
  });

  it("builds inputs from the member snapshot only", () => {
    const inputs = welcomeBackInputs(member({
      member: { id: "m", notificationCount: 2, chapterId: "ch-1" },
      broadcasts: [{ id: "b1", title: "Older", unread: true, publishedAt: at(-3) }, { id: "b2", title: "Newest", unread: true, publishedAt: at(-1) }, { id: "b3", title: "Read", unread: false, publishedAt: at(0) }],
      planItems: [{ id: "v", kind: "ballot", title: "Open vote", closed: false }, { id: "cast", kind: "ballot", title: "Cast", receiptCode: "SG-1" }],
      events: [{ id: "e", title: "Meeting", startsAt: at(2), chapterId: "ch-1" }, { id: "x", title: "Cancelled", startsAt: at(1), cancelledAt: at(0) }],
      cases: [{ id: "c1", status: "active" }, { id: "c2", status: "resolved" }],
    }), NOW);
    expect(inputs.unreadUpdates).toBe(4);
    expect(inputs.newestUpdateTitle).toBe("Newest");
    expect(inputs.openPolls).toEqual([{ id: "v", title: "Open vote" }]);
    expect(inputs.events.map((item) => item.id)).toEqual(["e"]);
    expect(inputs.activeCases.map((item) => item.id)).toEqual(["c1"]);
  });

  it("has Spanish copy for every English key", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("welcomeBack.") || key.startsWith(`settings.def.${SWITCH}.`) || key.startsWith("settings.def.limits.home.reactivation_after_days."));
    expect(keys.length).toBeGreaterThanOrEqual(33);
    for (const key of keys) expect(catalogue.es[key], key).toBeTruthy();
  });
});

describe("useWelcomeBack", () => {
  it("asks the server once per browser session and remembers the answer", async () => {
    const { rpc, transport } = liveTransport({ enabled: true, welcomeBack: true, afterDays: 21 });
    const data = member();
    const first = renderHook(() => useWelcomeBack({ data, transport }));
    await waitFor(() => expect(first.result.current.show).toBe(true));
    expect(rpc).toHaveBeenCalledWith(WELCOME_BACK_RPC);
    first.unmount();
    const second = renderHook(() => useWelcomeBack({ data, transport }));
    expect(second.result.current.show).toBe(true);
    act(() => second.result.current.dismiss());
    expect(second.result.current.show).toBe(false);
    second.unmount();
    const third = renderHook(() => useWelcomeBack({ data, transport }));
    expect(third.result.current.show).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("stays on the full Home for a refused read, a preview session, or the switch off", async () => {
    const refused = liveTransport(null, { code: "42501" });
    const a = renderHook(() => useWelcomeBack({ data: member(), transport: refused.transport }));
    await waitFor(() => expect(refused.rpc).toHaveBeenCalled());
    expect(a.result.current.show).toBe(false);
    window.sessionStorage.clear();
    const preview = liveTransport({ enabled: true, welcomeBack: true });
    renderHook(() => useWelcomeBack({ data: member(), transport: { ...preview.transport, preview: true } }));
    const off = liveTransport({ enabled: true, welcomeBack: true });
    renderHook(() => useWelcomeBack({ data: member({ organizationConfiguration: { switches: { [SWITCH]: false } } }), transport: off.transport }));
    await act(async () => {});
    expect(preview.rpc).not.toHaveBeenCalled();
    expect(off.rpc).not.toHaveBeenCalled();
  });

  it("records nothing for a shared demo persona and leaves a real member on the same device untouched", async () => {
    const demo = liveTransport({ enabled: true, welcomeBack: true });
    const shared = renderHook(() => useWelcomeBack({ data: member(), transport: { ...demo.transport, sharedDemoPersona: true } }));
    await act(async () => {});
    expect(demo.transport.createSessionClient).not.toHaveBeenCalled();
    expect(demo.rpc).not.toHaveBeenCalled();
    expect(shared.result.current.show).toBe(false);
    // Nothing was claimed for the day, so a real member is still asked once.
    expect(Object.keys(window.localStorage)).toEqual([]);
    const real = liveTransport({ enabled: true, welcomeBack: true });
    const own = renderHook(() => useWelcomeBack({ data: member(), transport: real.transport }));
    await waitFor(() => expect(own.result.current.show).toBe(true));
    expect(real.rpc).toHaveBeenCalledTimes(1);
    expect(real.rpc).toHaveBeenCalledWith(WELCOME_BACK_RPC);
  });

  // BUG-UG-WELCOME-BACK-ACTIVITY-CACHE-20261002.
  it("records activity once per day, again on a later day in the same tab, and then evaluates the return", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T15:00:00Z"));
    const answers = [
      { data: { enabled: true, welcomeBack: false, afterDays: 21 }, error: null },
      { data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null },
    ];
    const rpc = vi.fn(async () => answers.shift());
    const transport = { createSessionClient: vi.fn(() => ({ rpc })), session: { access_token: "token-1" } };
    const data = member();
    const hook = renderHook(() => useWelcomeBack({ data, transport }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(hook.result.current.show).toBe(false);
    // Same day: a refocus and another Home visit record nothing more.
    act(() => { window.dispatchEvent(new Event("focus")); });
    const again = renderHook(() => useWelcomeBack({ data, transport }));
    await act(async () => {});
    expect(rpc).toHaveBeenCalledTimes(1);
    again.unmount();
    // The tab stays open into a later day: resuming records again and the
    // server's answer for that day is shown.
    vi.setSystemTime(new Date("2026-10-03T15:00:00Z"));
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.show).toBe(true));
    expect(window.localStorage.getItem("ug-home-return:v2:active:member-1:org-1")).toBe("2026-10-03");
  });

  it("keeps a fresh tab from recording the same day twice, and keeps a dismissal for the visit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T15:00:00Z"));
    const { rpc, transport } = liveTransport({ enabled: true, welcomeBack: true, afterDays: 21 });
    const data = member();
    const first = renderHook(() => useWelcomeBack({ data, transport }));
    await waitFor(() => expect(first.result.current.show).toBe(true));
    act(() => first.result.current.dismiss());
    expect(first.result.current.show).toBe(false);
    first.unmount();
    // A new tab has no session state but shares the day mark.
    window.sessionStorage.clear();
    const fresh = renderHook(() => useWelcomeBack({ data, transport }));
    await act(async () => {});
    expect(fresh.result.current.show).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  // BUG-UG-WELCOME-BACK-PENDING-REFRESH-20261020
  function deferredTransport(token) {
    let answer;
    const response = new Promise((resolve) => { answer = resolve; });
    const rpc = vi.fn(() => response);
    const createSessionClient = vi.fn(() => ({ rpc }));
    const transportFor = (access) => ({ session: { access_token: access }, createSessionClient });
    return { rpc, createSessionClient, answer, response, transportFor, initial: transportFor(token) };
  }

  it("shows a welcome answered after a same-member token refresh, with no remount and no second request", async () => {
    const { rpc, answer, response, transportFor, initial } = deferredTransport("before-refresh");
    const data = member();
    const hook = renderHook(({ transport }) => useWelcomeBack({ data, transport }), { initialProps: { transport: initial } });
    expect(rpc).toHaveBeenCalledTimes(1);
    hook.rerender({ transport: transportFor("after-refresh") });
    await act(async () => { answer({ data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null }); await response; });
    expect(window.sessionStorage.getItem("ug-home-return:v2:member-1:org-1")).toBe("welcome");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(hook.result.current.show).toBe(true);
  });

  it("ignores a late answer from a member who left, and asks once for the member who arrived", async () => {
    const first = deferredTransport("token-a");
    const hook = renderHook(({ data, transport }) => useWelcomeBack({ data, transport }), { initialProps: { data: member(), transport: first.initial } });
    expect(first.rpc).toHaveBeenCalledTimes(1);
    const second = deferredTransport("token-b");
    const other = member({ member: { id: "member-2", organizationId: "org-2", firstName: "Ana", chapterId: "ch-1", notificationCount: 0 } });
    hook.rerender({ data: other, transport: second.initial });
    expect(second.rpc).toHaveBeenCalledTimes(1);
    await act(async () => { first.answer({ data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null }); await first.response; });
    // The departed member's answer is stored for that member only, never shown to the new scope.
    expect(hook.result.current.show).toBe(false);
    expect(window.sessionStorage.getItem("ug-home-return:v2:member-2:org-2")).toBeNull();
    await act(async () => { second.answer({ data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null }); await second.response; });
    expect(hook.result.current.show).toBe(true);
  });

  it("still waits for a session before asking, and asks once when it arrives", async () => {
    const { rpc, createSessionClient, transportFor } = deferredTransport("late-token");
    const data = member();
    const hook = renderHook(({ transport }) => useWelcomeBack({ data, transport }), { initialProps: { transport: { session: null, createSessionClient } } });
    expect(rpc).not.toHaveBeenCalled();
    hook.rerender({ transport: transportFor("late-token") });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(createSessionClient).toHaveBeenCalledWith({ access_token: "late-token" });
  });
});

describe("WelcomeBackScreen", () => {
  it("shows three facts and ONE picked next step, and taking it dismisses the screen", () => {
    const onDismiss = vi.fn();
    const onOpenUpdates = vi.fn();
    render(<LanguageProvider><WelcomeBackScreen data={member({ member: { id: "m", firstName: "Darnell", notificationCount: 1 } })} onDismiss={onDismiss} onOpenUpdates={onOpenUpdates} onOpenRights={vi.fn()} /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1, name: "Good to see you, Darnell." })).toBeTruthy();
    expect(screen.getByText("1 unread update")).toBeTruthy();
    expect(screen.getByText("Your worker support is still here")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Catch up on 1 update" }));
    expect(onDismiss).toHaveBeenCalled();
    expect(onOpenUpdates).toHaveBeenCalled();
  });

  it("falls back to organizing rights and always offers the full Home", () => {
    const onDismiss = vi.fn();
    const onOpenRights = vi.fn();
    render(<LanguageProvider><WelcomeBackScreen data={member()} onDismiss={onDismiss} onOpenRights={onOpenRights} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open organizing rights" }));
    expect(onOpenRights).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show my full Home" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

describe("TodayView welcome back", () => {
  it("replaces the full Home with the welcome-back screen until the member moves on", async () => {
    const { transport } = liveTransport({ enabled: true, welcomeBack: true, afterDays: 21 });
    const data = { ...fallbackData, organizationConfiguration: { switches: { [SWITCH]: true } }, member: { ...fallbackData.member, id: "member-77", organizationId: "org-1" } };
    render(<LanguageProvider><TodayView data={data} onPlanAction={() => {}} learningContent={transport} welcomeBack={{ onOpenRights: vi.fn(), onOpenUpdates: vi.fn() }} /></LanguageProvider>);
    expect(await screen.findByRole("button", { name: "Show my full Home" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show my full Home" }));
    expect(screen.queryByRole("button", { name: "Show my full Home" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 }).length).toBeGreaterThan(0);
  });
});
