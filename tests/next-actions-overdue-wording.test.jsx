// BUG-UG-WHAT-TO-DO-NEXT-OVERDUE-ITEMS-SAY-ACT-BEFORE-DEADLINE-20261110
// (#7984): an overdue item on staff What to do next never pairs its passed
// deadline with a "before the deadline" action line, and an upcoming deadline
// title no longer reads "deadline is due in 4 days". The panel is the one the
// steward and coordinator desks both mount.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NextActionsPanel } from "../src/features/caseSignals/CaseSignals.jsx";
import { caseSignalsCatalogue } from "../src/lib/i18n/caseSignals.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const TODAY = "2026-11-10";
const shift = (days) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const DAYS = [-3, -1, 0, 4];
// One case per distance, as get_case_queue_next_actions sends them.
function items() {
  return DAYS.flatMap((days) => ["deadline_risk", "missing_evidence"].map((kind) => ({
    id: `${kind}:c${days}`, kind, severity: days < 0 ? "critical" : "high", caseId: `c${days}`, reference: `GR-${days}`,
    memberId: `m${days}`, memberName: `Member ${days}`, dueDate: shift(days), days,
  })));
}

async function rows(lang) {
  const client = { rpc: vi.fn().mockResolvedValue({ data: { enabled: true, items: items(), summary: { total: 8, urgent: 8 } }, error: null }) };
  const view = render(<LanguageProvider lang={lang}><NextActionsPanel caseSignals={{ client, scopeKey: lang }} hat="committee member" /></LanguageProvider>);
  await screen.findAllByRole("listitem");
  const result = screen.getAllByRole("listitem").map((row) => {
    const [title, reason] = within(row).getAllByText(/./, { selector: "strong, small" }).map((node) => node.textContent);
    return { title, reason };
  });
  view.unmount();
  return result;
}

const copy = (lang, key) => caseSignalsCatalogue[lang][key];

describe("What to do next wording around a passed deadline", () => {
  it.each(["en", "es"])("never asks staff to beat a deadline that has passed (%s)", async (lang) => {
    const shown = await rows(lang);
    expect(shown).toHaveLength(8);
    const before = [copy(lang, "caseSignals.reason.deadline_risk"), copy(lang, "caseSignals.reason.missing_evidence")];
    const passed = [copy(lang, "caseSignals.reason.deadline_risk_passed"), copy(lang, "caseSignals.reason.missing_evidence_passed")];
    for (const row of shown) {
      const overdue = /GR--/.test(row.title);
      expect(overdue ? passed : before, row.title).toContain(row.reason);
      expect(row.title).not.toMatch(/is due in|is due today/);
    }
  });

  it("reads as the record asks in English and Spanish", async () => {
    const en = await rows("en");
    expect(en.map((row) => row.title)).toEqual(expect.arrayContaining([
      "Issue GR-4: deadline in 4 days (Nov 14)",
      "Issue GR-0: deadline today (Nov 10)",
      "Issue GR--3: deadline passed 3 days ago (Nov 7)",
      "Issue GR--1: deadline passed 1 day ago (Nov 9)",
      "Issue GR--3 has no evidence: deadline passed 3 days ago (Nov 7)",
    ]));
    expect(en).toEqual(expect.arrayContaining([
      { title: "Issue GR--3: deadline passed 3 days ago (Nov 7)", reason: "This deadline has passed. Act now, or record an extension or waiver." },
      { title: "Issue GR--3 has no evidence: deadline passed 3 days ago (Nov 7)", reason: "Attach evidence now; the deadline has passed." },
      { title: "Issue GR-0: deadline today (Nov 10)", reason: "Act before the deadline passes." },
    ]));
    const es = await rows("es");
    expect(es.map((row) => row.title)).toEqual(expect.arrayContaining([
      "Asunto GR-4: el plazo vence en 4 días (14 nov)",
      "Asunto GR-0: el plazo vence hoy (10 nov)",
      "Asunto GR--3: el plazo venció hace 3 días (7 nov)",
    ]));
    expect(es).toEqual(expect.arrayContaining([
      { title: "Asunto GR--3: el plazo venció hace 3 días (7 nov)", reason: "Este plazo ya venció. Actúa ahora o registra una prórroga o una dispensa." },
      { title: "El asunto GR--3 no tiene evidencia: el plazo venció hace 3 días (7 nov)", reason: "Adjunta evidencia ahora; el plazo ya venció." },
    ]));
  });

  it("has every new key in both catalogues", () => {
    for (const key of ["caseSignals.reason.deadline_risk_passed", "caseSignals.reason.missing_evidence_passed", "caseSignals.deadline.unnamed"]) {
      expect(caseSignalsCatalogue.en[key], key).toBeTruthy();
      expect(caseSignalsCatalogue.es[key], key).toBeTruthy();
    }
  });
});

// BUG-UG-WHAT-TO-DO-NEXT-DEADLINE-ITEM-DROPS-NO-EVIDENCE-20261124
// (#9901, ledger 870): since #9868 a case due inside the deadline lookahead
// raises only its deadline item, so that item says when the case has no
// evidence yet (the server's noEvidence key). Only a deadline item says it.
describe("What to do next says a deadline item has no evidence", () => {
  const payload = {
    enabled: true,
    summary: { total: 3, urgent: 3 },
    items: [
      { id: "deadline_risk:bare", kind: "deadline_risk", severity: "high", caseId: "bare", reference: "GR-2", memberName: "Member bare", dueDate: shift(2), days: 2, noEvidence: true },
      { id: "deadline_risk:filed", kind: "deadline_risk", severity: "high", caseId: "filed", reference: "GR-3", memberName: "Member filed", dueDate: shift(3), days: 3, noEvidence: false },
      { id: "missing_evidence:late", kind: "missing_evidence", severity: "high", caseId: "late", reference: "GR-10", memberName: "Member late", dueDate: shift(10), days: 10, noEvidence: true },
    ],
  };

  it.each(["en", "es"])("on the deadline item only (%s)", async (lang) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: payload, error: null }) };
    const view = render(<LanguageProvider lang={lang}><NextActionsPanel caseSignals={{ client, scopeKey: `no-evidence-${lang}` }} hat="committee member" /></LanguageProvider>);
    await screen.findAllByRole("listitem");
    const [bare, filed, late] = screen.getAllByRole("listitem");
    const line = copy(lang, "caseSignals.deadlineNoEvidence");
    expect(line).toBeTruthy();
    expect(within(bare).getByTestId("next-action-no-evidence").textContent).toBe(line);
    expect(within(filed).queryByTestId("next-action-no-evidence")).toBeNull();
    // The missing-evidence item already names the gap in its title.
    expect(within(late).queryByTestId("next-action-no-evidence")).toBeNull();
    view.unmount();
  });

  it("reads in English and Spanish", () => {
    expect(caseSignalsCatalogue.en["caseSignals.deadlineNoEvidence"]).toBe("This issue has no evidence yet.");
    expect(caseSignalsCatalogue.es["caseSignals.deadlineNoEvidence"]).toBe("Este asunto aún no tiene evidencia.");
  });
});
