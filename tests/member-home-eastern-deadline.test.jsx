import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WhatMattersNowCard } from "../src/features/memberHome/WhatMattersNowCard.jsx";
import { calendarDaysUntil, rankWhatMattersNow } from "../src/features/memberHome/whatMattersNow.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const cases = (deadlineValue = "2026-06-21") => [{ id: "case-509", reference: "GR-2026-509", status: "active", deadlineValue }];
function card(lang = "en", deadlineValue) {
  return render(<LanguageProvider lang={lang}><WhatMattersNowCard data={{ cases: cases(deadlineValue) }} /></LanguageProvider>);
}

describe("Home uses Eastern calendar days", () => {
  it.each([
    ["2026-11-09T17:00:00Z", "2026-06-21", -141],
    ["2026-11-10T04:59:59Z", "2026-06-21", -141],
    ["2026-11-10T05:00:00Z", "2026-06-21", -142],
    ["2026-03-08T04:59:59Z", "2026-03-08", 1],
    ["2026-03-08T05:00:00Z", "2026-03-08", 0],
    ["2026-03-08T06:59:59Z", "2026-03-09", 1],
    ["2026-03-08T07:00:00Z", "2026-03-09", 1],
    ["2026-03-09T03:59:59Z", "2026-03-09", 1],
    ["2026-03-09T04:00:00Z", "2026-03-09", 0],
    ["2026-11-01T03:59:59Z", "2026-11-01", 1],
    ["2026-11-01T04:00:00Z", "2026-11-01", 0],
    ["2026-11-01T05:59:59Z", "2026-11-02", 1],
    ["2026-11-01T06:00:00Z", "2026-11-02", 1],
    ["2026-11-02T04:59:59Z", "2026-11-02", 1],
    ["2026-11-02T05:00:00Z", "2026-11-02", 0],
    ["2026-03-07T17:00:00Z", "2026-03-09", 2],
    ["2026-10-31T16:00:00Z", "2026-11-02", 2],
  ])("at %s counts the date-only deadline %s as %i days away", (instant, deadline, days) => {
    expect(calendarDaysUntil(deadline, new Date(instant))).toBe(days);
  });

  it("keeps the saved deadline and urgency stable for a fixed instant", () => {
    expect(rankWhatMattersNow({ cases: cases(), now: new Date("2026-11-09T17:00:00Z") })).toMatchObject({
      kind: "filing_deadline", days: -141, urgency: "critical", deadline: "2026-06-21",
    });
    expect(calendarDaysUntil("not-a-date", new Date("2026-11-09T17:00:00Z"))).toBeNull();
    expect(calendarDaysUntil("2026-06-21", new Date("invalid"))).toBeNull();
  });

  it.each([
    ["en", "141 days overdue", "142 days overdue"],
    ["es", "141 días vencido", "142 días vencido"],
  ])("refreshes the mounted %s age at Eastern midnight without a reload", async (lang, before, after) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T04:59:59Z"));
    const { unmount } = card(lang);
    expect(screen.getByText(new RegExp(before))).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(screen.getByText(new RegExp(before))).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText(new RegExp(after))).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["2026-03-08T05:00:00Z", "2026-03-09", 23],
    ["2026-11-01T04:00:00Z", "2026-11-02", 25],
  ])("refreshes after the %s Eastern day lasts %s (%i hours)", async (start, deadline, hours) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(start));
    const { unmount } = card("en", deadline);
    expect(screen.getByText(/due tomorrow/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(hours * 3_600_000 - 1));
    expect(screen.getByText(/due tomorrow/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText(/due today/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(86_400_000));
    expect(screen.getByText(/1 day overdue/)).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

});
