// BUG-UG-MY-CASES-STEPPER-PRINTS-CASE-NOTES-AS-STEPS-20261122 (#9569,
// site audit B-8): the desktop My cases strip is a stage stepper. It printed
// every case note in full, bold and centred, as a step before the real stages.
// It now shows stages only; the latest note stays in the Latest line, and the
// whole history stays in the case dialog. This edition has no grievance
// stages, so every issue's strip is the open node and Resolution.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CasesView } from "../src/views/CasesView.jsx";

const INTAKE_NOTE = "Intake call with Marcus. Marcus reported the AC failure on van T-14 to the garage three times.";
const LETTER_NOTE = "Got the letter from HR today. Do I need to sign it?";

function memberCase(id, step, updates = []) {
  return { id, reference: `GR-${id}`, title: `Case ${id}`, type: "Grievance", status: "active", step, deadline: "Nov 13", deadlineValue: "2026-11-13", overdue: false, updates, files: [] };
}

const notes = [
  { id: "n1", body: INTAKE_NOTE, created_at: "2026-09-15T14:00:00Z" },
  { id: "n2", body: LETTER_NOTE, created_at: "2026-09-18T14:00:00Z" },
];

function strips(view) {
  return [...view.container.querySelectorAll(".mcases-desk__strip")].map((strip) => ({
    labels: [...strip.querySelectorAll(".mcases-desk__nlabel")].map((node) => node.textContent),
    centered: strip.classList.contains("mcases-desk__strip--center-current"),
    // Only the current stage carries a marker; no stage is marked completed.
    marks: [...strip.querySelectorAll(".mcases-desk__icon")].map((node) => node.textContent),
  }));
}

afterEach(() => cleanup());

describe("desktop My cases stage strip (#9569)", () => {
  it("shows stages only, never a case note, and keeps the latest note in the Latest line", () => {
    const view = render(<LanguageProvider lang="en"><CasesView desktop data={{ cases: [memberCase("step2", "Step 2", notes), memberCase("intake", "Intake", notes)] }} /></LanguageProvider>);
    expect(strips(view)).toEqual([
      { labels: ["Open", "Resolution"], centered: true, marks: ["●", ""] },
      { labels: ["Open", "Resolution"], centered: true, marks: ["●", ""] },
    ]);
    for (const strip of view.container.querySelectorAll(".mcases-desk__strip")) {
      expect(strip.textContent).not.toContain("✓");
      expect(strip.querySelectorAll(".mcases-desk__nlabel--todo")).toHaveLength(strip.querySelectorAll(".mcases-desk__node").length - 1);
      expect(strip.textContent).not.toContain("Marcus");
      expect(strip.textContent).not.toContain("letter from HR");
    }
    const latest = [...view.container.querySelectorAll(".mcases-desk__latesttext")].map((node) => node.textContent);
    expect(latest).toHaveLength(2);
    for (const text of latest) expect(text).toContain(LETTER_NOTE);
  });

  it("names the open node in Spanish and draws no stage path for any stored step", () => {
    const view = render(<LanguageProvider lang="es"><CasesView desktop data={{ cases: [memberCase("s3", "Step 3", notes), memberCase("arb", "Arbitration", notes), memberCase("custom", "Hearing prep")] }} /></LanguageProvider>);
    expect(strips(view)).toEqual([
      { labels: ["Abierto", "Resolución"], centered: true, marks: ["●", ""] },
      { labels: ["Abierto", "Resolución"], centered: true, marks: ["●", ""] },
      { labels: ["Abierto", "Resolución"], centered: true, marks: ["●", ""] },
    ]);
  });

  // Sol on 4dc89b1d: a note that is no longer drawn in the strip is still
  // reachable from the card, in the Full case history.
});
