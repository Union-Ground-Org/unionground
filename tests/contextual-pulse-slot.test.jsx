// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014): the web
// reading-screen slot asks after the dwell OR scroll threshold, once per tab
// session, only while the organization switch is on, and answers through the
// prompt's own event. The staff editor offers only real screens.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextualPulseSlot } from "../src/features/engagement/ContextualPulseSlot.jsx";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { PULSE_SESSION_STORAGE_KEY, PULSE_SESSION_USED_STORAGE_KEY } from "../src/features/engagement/contextualPulse.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ON = { switches: { "features.engagement_voice.contextual_pulses": true, "limits.engagement_voice.pulse_dwell_seconds": 20, "limits.engagement_voice.pulse_scroll_percent": 50 } };
const OFF = { switches: { "features.engagement_voice.contextual_pulses": false } };
const SHOWN = { eligible: true, eventId: "event-1", promptId: "prompt-1", question: "Was this clause clear?", options: ["Yes", "No"], contextKey: "contract.page" };

function slot(configuration = ON, lang = "en", contextKey = "contract.page", active = true) {
  return render(<LanguageProvider lang={lang}><ContextualPulseSlot pulse={{ client: {}, configuration }} contextKey={contextKey} active={active} /></LanguageProvider>);
}

beforeEach(() => {
  globalThis.sessionStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reading-screen quick check (web)", () => {
  it("counts only foreground reading time across a hidden tab", async () => {
    const evaluate = vi.spyOn(engagementApi, "evaluatePulseInContext").mockResolvedValue({ eligible: false, reason: "sampled_out" });
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      slot();
      await act(async () => { vi.advanceTimersByTime(10_000); });
      hidden = true;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(60_000); });
      expect(evaluate).not.toHaveBeenCalled();
      hidden = false;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(9_000); });
      expect(evaluate).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0][3]).toBe(20);
    } finally {
      delete document.hidden;
    }
  });
  it("asks after 20 seconds of reading and answers through the shown event", async () => {
    const evaluate = vi.spyOn(engagementApi, "evaluatePulseInContext").mockResolvedValue(SHOWN);
    const respond = vi.spyOn(engagementApi, "respondPulse").mockResolvedValue({ eventId: "event-1", state: "responded" });
    slot();
    await act(async () => { vi.advanceTimersByTime(19_000); });
    expect(evaluate).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    const [, contextKey, sessionKey, dwell, scroll] = evaluate.mock.calls[0];
    expect(contextKey).toBe("contract.page");
    expect(sessionKey).toBe(globalThis.sessionStorage.getItem(PULSE_SESSION_STORAGE_KEY));
    expect(dwell).toBeGreaterThanOrEqual(20);
    expect(scroll).toBe(0);
    vi.useRealTimers();
    const card = await screen.findByRole("region", { name: "Was this clause clear?" });
    fireEvent.click(within(card).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith({}, "event-1", "Yes", false));
    expect(await screen.findByRole("status")).toHaveTextContent("Response saved");
    expect(screen.queryByRole("region", { name: "Was this clause clear?" })).not.toBeInTheDocument();
    expect(globalThis.sessionStorage.getItem(PULSE_SESSION_USED_STORAGE_KEY)).toBe("1");
  });

  it("dismisses through Not now and says so", async () => {
    vi.spyOn(engagementApi, "evaluatePulseInContext").mockResolvedValue(SHOWN);
    const respond = vi.spyOn(engagementApi, "respondPulse").mockResolvedValue({ eventId: "event-1", state: "dismissed" });
    slot();
    await act(async () => { vi.advanceTimersByTime(20_000); });
    vi.useRealTimers();
    const card = await screen.findByRole("region", { name: "Was this clause clear?" });
    fireEvent.click(within(card).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith({}, "event-1", null, true));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Was this clause clear?" })).not.toBeInTheDocument();
  });

  it("asks as soon as half the page is scrolled", async () => {
    const evaluate = vi.spyOn(engagementApi, "evaluatePulseInContext").mockResolvedValue({ eligible: false, reason: "sampled_out" });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    slot();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 600 });
    await act(async () => { document.dispatchEvent(new Event("scroll")); });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][4]).toBe(60);
    expect(globalThis.sessionStorage.getItem(PULSE_SESSION_USED_STORAGE_KEY)).toBeNull();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    delete document.documentElement.scrollHeight;
  });

  it("never asks while the organization switch is off, on a blocked screen, while inactive, or after the session is spent", async () => {
    const evaluate = vi.spyOn(engagementApi, "evaluatePulseInContext").mockResolvedValue(SHOWN);
    slot(OFF);
    slot(ON, "en", "case.updated");
    slot(ON, "en", "contract.page", false);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(evaluate).not.toHaveBeenCalled();
    cleanup();
    globalThis.sessionStorage.setItem(PULSE_SESSION_USED_STORAGE_KEY, "1");
    slot();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps the card and says so in Spanish when the answer fails to save", async () => {
    vi.spyOn(engagementApi, "evaluatePulseInContext").mockResolvedValue(SHOWN);
    vi.spyOn(engagementApi, "respondPulse").mockRejectedValue(new Error("offline"));
    slot(ON, "es");
    await act(async () => { vi.advanceTimersByTime(20_000); });
    vi.useRealTimers();
    const card = await screen.findByRole("region", { name: "Was this clause clear?" });
    fireEvent.click(within(card).getByRole("button", { name: "Ahora no" }));
    expect(await within(card).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Was this clause clear?" })).toBeInTheDocument();
  });
});

describe("staff prompt editor offers only real screens", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [], livePolls: [], channels: [], pulsePrompts: [
      { id: "legacy", eventKey: "case.updated", question: "Need help?", options: ["Yes", "No"], active: true, cooldownHours: 168, shown: 0, responded: 0 },
      { id: "contract", eventKey: "contract.page", question: "Clear?", options: ["Yes", "No"], active: true, cooldownHours: 168, shown: 0, responded: 0 },
    ] });
    vi.spyOn(engagementApi, "savePulsePrompt").mockResolvedValue({});
  });

  it("lists the registered screens with readable names and explains the switch", async () => {
    render(<LanguageProvider lang="en"><StaffEngagement client={{}} /></LanguageProvider>);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Contextual" }));
    expect(await screen.findByText("Contract clauses")).toBeInTheDocument();
    expect(screen.getByText("case.updated (no screen asks this)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
    const picker = screen.getByLabelText("Where to ask");
    expect(within(picker).getAllByRole("option").map((option) => option.value)).toEqual(["voice.open", "contract.page", "rights.page", "qa.detail", "issue-thread.detail"]);
    expect(picker).toHaveValue("voice.open");
    fireEvent.change(picker, { target: { value: "rights.page" } });
    expect(picker).toHaveAccessibleDescription(/Quick checks on reading screens switch/);
  });

  it("keeps a legacy prompt's key until staff choose a real screen", async () => {
    render(<LanguageProvider lang="en"><StaffEngagement client={{}} /></LanguageProvider>);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Contextual" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit prompt: Need help?" }));
    const picker = screen.getByLabelText("Where to ask");
    expect(picker).toHaveValue("case.updated");
    expect(picker).toHaveAccessibleDescription(/never asks/);
    fireEvent.change(picker, { target: { value: "qa.detail" } });
    fireEvent.submit(picker.closest("form"));
    await waitFor(() => expect(engagementApi.savePulsePrompt).toHaveBeenCalledWith({}, expect.objectContaining({ id: "legacy", eventKey: "qa.detail" })));
  });
});
