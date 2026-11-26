// BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110
// (#7979): one case, one date, one label. A case due Nov 27 with a missed
// procedure step deadline on Nov 8 shows "Step 1 deadline passed 1 day ago
// (Nov 8)" in staff What to do next, on the member's My cases card and on
// member Home; a case without an earlier step deadline keeps today's output.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextActionsPanel, nextActionTitle } from "../src/features/caseSignals/CaseSignals.jsx";
import { WhatMattersNowCard } from "../src/features/memberHome/WhatMattersNowCard.jsx";
import { calendarDaysUntil, rankWhatMattersNow } from "../src/features/memberHome/whatMattersNow.js";
import { caseDeadlinePhrase, caseNextDeadline, deadlineDayText, sentenceStart, withNextDeadlines } from "../src/lib/caseNextDeadline.js";
import { caseSignalsT } from "../src/lib/i18n/caseSignals.js";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CasesView } from "../src/views/CasesView.jsx";

// Nov 9, 2026, noon Eastern.
const NOW = new Date("2026-11-09T17:00:00Z");
const REFERENCE = "GR-2026-14296";
// The step sweep marks a deadline missed after its moment: Nov 8, 11:59:59 PM ET.
const MISSED_STEP = { case_id: "case-1", id: "d-1", label: "Step 1", due_at: "2026-11-09T04:59:59+00:00", status: "missed" };
const LATER_STEP = { case_id: "case-1", id: "d-2", label: "Step 2", due_at: "2026-11-20T04:59:59+00:00", status: "active" };
const SETTLED_STEP = { case_id: "case-1", id: "d-0", label: "Step 0", due_at: "2026-11-02T04:59:59+00:00", status: "met" };
const PHRASE_EN = "Step 1 deadline passed 1 day ago (Nov 8)";
const PHRASE_ES = "el plazo de Step 1 venció hace 1 día (8 nov)";

// The staff projection for this case (get_case_queue_next_actions, #7979).
const STAFF_ITEM = {
  id: "deadline_risk:case-1", kind: "deadline_risk", severity: "critical", caseId: "case-1", reference: REFERENCE,
  step: "Intake", memberId: "m-1", memberName: "Ibrahim Kamara", dueDate: "2026-11-08", dueKind: "step", dueLabel: "Step 1", days: -1,
};

function memberCase(rows, overrides = {}) {
  const [shaped] = withNextDeadlines([{ id: "case-1", deadline: "2026-11-27" }], rows);
  return {
    id: "case-1", reference: REFERENCE, title: "Schedule change grievance", type: "Scheduling", articles: "",
    status: "active", step: "Intake", deadline: "Nov 27, 2026", deadlineValue: "2026-11-27", overdue: false,
    updates: [], files: [], nextDeadline: shaped.nextDeadline, ...overrides,
  };
}

const caseProps = {
  onCreateCase: vi.fn(), onUpdateCase: vi.fn(), onAddCaseUpdate: vi.fn(), onAddCaseFile: vi.fn(),
  onRemoveCaseFile: vi.fn(), onOpenCaseFile: vi.fn(),
};
const homeData = (cases) => ({
  organizationConfiguration: { switches: { "features.home.what_matters_now": true } },
  member: { chapterId: "ch-1" }, cases, planItems: [], events: [],
});

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("the deadline a issue runs to first", () => {
  it("is the earliest open step deadline before the issue's own deadline, missed ones included", () => {
    expect(caseNextDeadline("2026-11-27", [LATER_STEP, MISSED_STEP, SETTLED_STEP])).toEqual({ kind: "step", label: "Step 1", dueOn: "2026-11-08", missed: true, timeZone: "America/New_York" });
  });

  it("stays the issue's own deadline when no open step comes first, as before", () => {
    expect(caseNextDeadline("2026-11-27", [])).toEqual({ kind: "case", label: null, dueOn: "2026-11-27", missed: false, timeZone: "America/New_York" });
    expect(caseNextDeadline("2026-11-27", [SETTLED_STEP])).toMatchObject({ kind: "case", dueOn: "2026-11-27" });
    // A step on the case's own day is not earlier (the server names the case).
    expect(caseNextDeadline("2026-11-08", [MISSED_STEP])).toMatchObject({ kind: "case", dueOn: "2026-11-08" });
    expect(caseNextDeadline(null, [MISSED_STEP])).toMatchObject({ kind: "step", dueOn: "2026-11-08" });
    expect(caseNextDeadline(null, [])).toBeNull();
  });
});

describe("the shared rule and wording at their edges", () => {
  const en = (key, vars) => caseSignalsT("en", key, vars);

  it("breaks same-moment ties by id as the SQL does, reads date-only rows as their day and skips unusable rows", () => {
    // get_case_queue_next_actions orders by due_at, then id (uuid byte order).
    const at = "2026-11-12T22:00:00+00:00";
    expect(caseNextDeadline("2026-11-27", [
      { id: "00000000-0000-4000-8000-000000000002", label: "Step 1", due_at: at, status: "active" },
      { id: "00000000-0000-4000-8000-000000000001", label: "Step 9", due_at: at, status: "extended" },
    ])).toEqual({ kind: "step", label: "Step 9", dueOn: "2026-11-12", missed: false, timeZone: "America/New_York" });
    expect(caseNextDeadline("2026-11-27", [
      { id: "00000000-0000-4000-8000-00000000000B", label: "Upper", due_at: at, status: "active" },
      { id: "00000000-0000-4000-8000-00000000000a", label: "Lower", due_at: at, status: "active" },
    ])).toMatchObject({ label: "Lower" });
    // Microseconds Postgres keeps decide before the id does.
    expect(caseNextDeadline("2026-11-27", [
      { id: "00000000-0000-4000-8000-000000000001", label: "Later", due_at: "2026-11-12T22:00:00.000002+00:00", status: "active" },
      { id: "00000000-0000-4000-8000-000000000009", label: "Earlier", due_at: "2026-11-12T22:00:00.000001+00:00", status: "active" },
    ])).toMatchObject({ label: "Earlier" });
    expect(caseNextDeadline("2026-11-27", [{ id: "x", due_at: "2026-11-20", status: "active" }])).toEqual({ kind: "step", label: "", dueOn: "2026-11-20", missed: false, timeZone: "America/New_York" });
    expect(caseNextDeadline("not a date", [null, { id: "y", label: "Step 1", due_at: "", status: "active" }, { id: "z", label: "Step 1", due_at: 5, status: "active" }])).toBeNull();
    expect(caseNextDeadline("2026-11-27", "rows")).toMatchObject({ kind: "case" });
  });

  it("attaches each issue's own rows only", () => {
    const shaped = withNextDeadlines([{ id: "case-1", deadline: "2026-11-27" }, { id: "case-2", deadline: null }], [null, { id: "orphan" }, MISSED_STEP, { ...LATER_STEP, case_id: "case-2" }]);
    expect(shaped.map((item) => item.nextDeadline)).toEqual([
      { kind: "step", label: "Step 1", dueOn: "2026-11-08", missed: true, timeZone: "America/New_York" },
      { kind: "step", label: "Step 2", dueOn: "2026-11-19", missed: false, timeZone: "America/New_York" },
    ]);
    expect(withNextDeadlines([{ id: "case-1", deadline: "2026-11-27" }], null)[0].nextDeadline).toMatchObject({ kind: "case" });
  });

  it("words every distance the same way for both sides", () => {
    const phrase = (days, kind = "step", label = "Step 1") => caseDeadlinePhrase(en, { kind, label, days, dueOn: "2026-11-12" });
    expect(phrase(-3)).toBe("Step 1 deadline passed 3 days ago (Nov 12)");
    expect(phrase(0)).toBe("Step 1 deadline today (Nov 12)");
    expect(phrase(1)).toBe("Step 1 deadline in 1 day (Nov 12)");
    expect(phrase(5, "step", "")).toBe("Step deadline in 5 days (Nov 12)");
    expect(phrase(null, "case")).toBe("issue deadline (Nov 12)");
    expect(phrase(4, null)).toBe("deadline in 4 days (Nov 12)");
    expect(caseDeadlinePhrase(en, { kind: "case", label: null, days: 2, dueOn: "2026-11-12" })).toBe("issue deadline in 2 days (Nov 12)");
    expect(deadlineDayText("Nov 12")).toBe("");
    expect(deadlineDayText("2026-11-12", "es")).toBe("12 nov");
    expect(sentenceStart("el plazo")).toBe("El plazo");
    expect(sentenceStart("")).toBe("");
    expect(sentenceStart(null)).toBeNull();
  });
});

describe("staff What to do next names the deadline", () => {

  it("names the issue deadline too, and a plain deadline when the server does not say", () => {
    const en = (key, vars) => caseSignalsT("en", key, vars);
    const caseItem = { ...STAFF_ITEM, dueKind: "case", dueLabel: null, dueDate: "2026-11-12", days: 3 };
    expect(nextActionTitle(en, caseItem)).toBe(`Issue ${REFERENCE}: issue deadline in 3 days (Nov 12)`);
    expect(nextActionTitle(en, { ...caseItem, kind: "missing_evidence" })).toBe(`Issue ${REFERENCE} has no evidence: issue deadline in 3 days (Nov 12)`);
    expect(nextActionTitle(en, { ...caseItem, dueKind: null })).toBe(`Issue ${REFERENCE}: deadline in 3 days (Nov 12)`);
  });
});

describe("the worker reads the same date with the same label", () => {
  it("on the My issues card", () => {
    const { unmount } = render(<CasesView data={{ cases: [memberCase([MISSED_STEP, LATER_STEP])] }} {...caseProps} />);
    expect(screen.getByText(PHRASE_EN)).toBeInTheDocument();
    expect(screen.queryByText(/Nov 27/)).not.toBeInTheDocument();
    unmount();
    render(<LanguageProvider lang="es"><CasesView data={{ cases: [memberCase([MISSED_STEP])] }} {...caseProps} /></LanguageProvider>);
    expect(screen.getByText("El plazo de Step 1 venció hace 1 día (8 nov)")).toBeInTheDocument();
  });

  it("ranks the step on Home's filing-deadline rule, not the later issue date", () => {
    expect(rankWhatMattersNow({ cases: [memberCase([MISSED_STEP])], now: NOW })).toMatchObject({
      kind: "filing_deadline", urgency: "critical", days: -1, deadline: "2026-11-08", deadlineKind: "step", deadlineLabel: "Step 1",
    });
  });

  it("keeps today's output for a issue with no step deadline", () => {
    const plain = memberCase([]);
    expect(rankWhatMattersNow({ cases: [plain], now: NOW })).toEqual({
      kind: "case_in_progress", urgency: "info", case: { id: "case-1", reference: REFERENCE, title: "Schedule change grievance" },
      deadline: "2026-11-27", action: { kind: "open_case", caseId: "case-1" },
    });
    const { unmount } = render(<CasesView data={{ cases: [plain] }} {...caseProps} />);
    expect(screen.getByText("Due Nov 27")).toBeInTheDocument();
    unmount();
    render(<LanguageProvider lang="en"><WhatMattersNowCard data={homeData([plain])} /></LanguageProvider>);
    expect(screen.getByText(`${REFERENCE} is in progress and nothing is due in the next three days.`)).toBeInTheDocument();
  });

  it("carries every new label in both catalogues", () => {
    for (const key of ["whatMatters.reasonStep", "whatMatters.reasonStepPassed", "whatMatters.lineStep", "whatMatters.stepDeadlineOn",
      "caseSignals.deadline.step", "caseSignals.deadline.case", "caseSignals.deadline.phrase", "caseSignals.deadline.passedOne",
      "caseSignals.title.deadline_named", "caseSignals.title.missing_evidence_named"]) {
      expect(catalogue.en[key], key).toBeTruthy();
      expect(catalogue.es[key], key).toBeTruthy();
    }
  });
});

// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: a step
// deadline is dated on the zone it was set in, and the deadline that comes
// first is the one with fewer days left, each counted on its own zone, as
// private.case_next_deadline counts them. Two fictional zones 25 hours apart.
describe("each deadline on the zone it was set in", () => {
  const at = new Date("2026-12-01T12:00:00Z"); // December 2 in Kiritimati, December 1 in Pago Pago and New York
  const east = "Pacific/Kiritimati";
  const west = "Pacific/Pago_Pago";

  it("dates a step deadline on its own zone and says which zone its days are counted on", () => {
    const step = { id: "s", label: "Step 1", due_at: "2026-12-01T12:30:00Z", status: "active", time_zone: east };
    expect(caseNextDeadline(null, [step], { now: at })).toEqual({ kind: "step", label: "Step 1", dueOn: "2026-12-02", missed: false, timeZone: east });
  });

  it("picks the deadline with fewer days left, each on its own zone", () => {
    // Due today in Kiritimati; the case's own December 2 is a day away in Pago Pago.
    const step = { id: "s", label: "Step 1", due_at: "2026-12-02T09:00:00Z", status: "active", time_zone: east };
    expect(caseNextDeadline("2026-12-02", [step], { caseTimeZone: west, now: at })).toMatchObject({ kind: "step", dueOn: "2026-12-02", timeZone: east });
    expect(caseNextDeadline("2026-12-02", [step], { caseTimeZone: east, now: at })).toMatchObject({ kind: "case", timeZone: east });
    const [shown] = withNextDeadlines([{ id: "c", deadline: "2026-12-02", time_zone: west }], [{ ...step, case_id: "c" }], undefined, undefined, at);
    expect(shown.nextDeadline).toMatchObject({ kind: "step", timeZone: east });
  });

  it("says the same on the My issues card (final, stage 568B)", () => {
    vi.setSystemTime(at);
    const step = { id: "s", case_id: "case-1", label: "Step 1", due_at: "2026-12-02T09:00:00Z", status: "active", time_zone: east };
    const [item] = withNextDeadlines([{ ...memberCase([]), deadline: null, deadlineValue: null, time_zone: west }], [step], undefined, undefined, at);
    render(<CasesView data={{ cases: [item] }} {...caseProps} />);
    // Due today in Kiritimati, where it was set, while New York is still on December 1.
    expect(screen.getByText("Step 1 deadline today (Dec 2)")).toBeInTheDocument();
  });

  it("counts the worker's Home deadline days on that zone", () => {
    expect(calendarDaysUntil("2026-12-02", at, east)).toBe(0);
    expect(calendarDaysUntil("2026-12-02", at, west)).toBe(1);
  });
});
