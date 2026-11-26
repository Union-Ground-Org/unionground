// REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001: the ranked "What matters for
// you now" rules, one primary next action per visit.
import { describe, expect, it } from "vitest";
import * as whatMattersNow from "../src/features/memberHome/whatMattersNow.js";

const { FILING_DEADLINE_RISK_DAYS, calendarDaysUntil, rankWhatMattersNow } = whatMattersNow;

// Fixed Eastern noon, independent of the runner's zone.
const NOW = new Date("2026-10-01T12:00:00-04:00");
const day = (offset) => {
  return new Date(Date.UTC(2026, 9, 1 + offset)).toISOString().slice(0, 10);
};
const at = (offsetDays) => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();

const quietCase = { id: "c-quiet", reference: "IS-1", title: "Overtime", status: "active", deadlineValue: day(20) };
const ballot = { id: "b1", title: "Ratify the agreement", closed: false, voted: false, closesAt: at(3) };
const event = { id: "e1", title: "Chapter meeting", startsAt: at(2), responded: false };

describe("calendarDaysUntil", () => {
  it("counts whole Eastern calendar days and rejects non-dates", () => {
    expect(calendarDaysUntil(day(0), NOW)).toBe(0);
    expect(calendarDaysUntil(day(1), NOW)).toBe(1);
    expect(calendarDaysUntil(day(-2), NOW)).toBe(-2);
    expect(calendarDaysUntil(`${day(5)}T00:00:00Z`, NOW)).toBe(5);
    expect(calendarDaysUntil("soon", NOW)).toBeNull();
    expect(calendarDaysUntil(null, NOW)).toBeNull();
  });
});

describe("rankWhatMattersNow", () => {
  it("ranks an issue deadline within three days above everything else", () => {
    const urgent = { ...quietCase, id: "c-urgent", reference: "IS-2", deadlineValue: day(FILING_DEADLINE_RISK_DAYS) };
    const result = rankWhatMattersNow({
      cases: [quietCase, urgent, { id: "c-ulp", status: "active", ulpDeadline: day(2), retaliationFlagged: true }],
      ballots: [ballot], events: [event], now: NOW,
    });
    expect(result).toMatchObject({ kind: "filing_deadline", urgency: "warning", days: 3, case: { id: "c-urgent", reference: "IS-2" }, action: { kind: "open_case", caseId: "c-urgent" } });
  });

  it("treats an overdue filing deadline as critical and ignores resolved cases", () => {
    const result = rankWhatMattersNow({
      cases: [{ ...quietCase, deadlineValue: day(-1) }, { ...quietCase, id: "done", status: "resolved", deadlineValue: day(-5) }],
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "filing_deadline", urgency: "critical", days: -1, case: { id: "c-quiet" } });
  });

  // Union Ground has no unfair labor practice deadline and no staff
  // retaliation flag (owner decision, 2026-10-13): neither ranks, and neither
  // constant is exported.
  it("exports no ULP threshold", () => {
    expect(whatMattersNow).not.toHaveProperty("ULP_ATTENTION_DAYS");
    expect(whatMattersNow).not.toHaveProperty("ULP_CRITICAL_DAYS");
  });

  it("never ranks a ULP deadline, even a passed or imminent one, above a quiet issue", () => {
    for (const offset of [-3, 0, 1, 7, 30]) {
      const result = rankWhatMattersNow({ cases: [{ ...quietCase, ulpDeadline: day(offset), ulpSource: "law" }], now: NOW });
      expect(result, `ULP in ${offset} days`).toMatchObject({ kind: "case_in_progress", case: { id: "c-quiet" }, deadline: day(20), action: { kind: "open_case", caseId: "c-quiet" } });
    }
  });

  it("never surfaces a retaliation flag or a ULP date without an active issue", () => {
    const pending = rankWhatMattersNow({
      cases: [{ id: "c-flag", reference: "IS-9", status: "pending", retaliationFlagged: true, ulpDeadline: day(2) }],
      ballots: [ballot], now: NOW,
    });
    expect(pending).toMatchObject({ kind: "open_vote", ballot: { id: "b1" } });
    const only = rankWhatMattersNow({ cases: [{ id: "c-flag", status: "pending", retaliationFlagged: true, ulpDeadline: day(1) }], now: NOW });
    expect(only).toEqual({ kind: "caught_up", urgency: "calm", action: null });
    for (const result of [pending, only]) {
      expect(["ulp_deadline", "retaliation"]).not.toContain(result.kind);
      expect(result.action?.kind).not.toBe("message_steward");
    }
  });

  it("carries no grievance step in the issue summary", () => {
    const result = rankWhatMattersNow({ cases: [{ ...quietCase, step: "Step 1" }], now: NOW });
    expect(result.kind).toBe("case_in_progress");
    expect(result.case).not.toHaveProperty("step");
    const urgent = rankWhatMattersNow({ cases: [{ ...quietCase, step: "Step 1", deadlineValue: day(1) }], now: NOW });
    expect(urgent.case).not.toHaveProperty("step");
  });

  it("falls through to the next action when an issue is not active", () => {
    const result = rankWhatMattersNow({ cases: [{ id: "c-old", status: "pending" }], ballots: [], events: [event], now: NOW });
    expect(result.kind).toBe("rsvp");
  });

  it("offers the open vote closing soonest, never a cast or closed one", () => {
    const result = rankWhatMattersNow({
      ballots: [
        { id: "later", title: "Later", closed: false, voted: false, closesAt: at(6) },
        { id: "cast", title: "Cast", closed: false, voted: true, closesAt: at(1) },
        { id: "closed", title: "Closed", closed: true, voted: false, closesAt: at(-1) },
        { id: "sooner", title: "Sooner", closed: false, voted: false, closesAt: at(2) },
      ],
      events: [event], now: NOW,
    });
    expect(result).toMatchObject({ kind: "open_vote", ballot: { id: "sooner" }, action: { kind: "vote", ballotId: "sooner" } });
  });

  it("offers the next unanswered event within seven days", () => {
    const result = rankWhatMattersNow({
      events: [
        { id: "answered", title: "A", startsAt: at(1), responded: true },
        { id: "cancelled", title: "C", startsAt: at(1), cancelled: true },
        { id: "past", title: "P", startsAt: at(-1) },
        { id: "far", title: "F", startsAt: at(8) },
        { id: "next", title: "Steward training", startsAt: at(4) },
      ],
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "rsvp", event: { id: "next", title: "Steward training" }, action: { kind: "open_event", eventId: "next" } });
  });

  it("is caught up with nothing to do", () => {
    expect(rankWhatMattersNow({ now: NOW })).toEqual({ kind: "caught_up", urgency: "calm", action: null });
    expect(rankWhatMattersNow({ cases: null, ballots: undefined, events: "x", now: NOW }).kind).toBe("caught_up");
  });
});
