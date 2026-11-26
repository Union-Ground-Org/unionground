import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";

// UX-UG-WORKLOAD-OT-STEPPER-HOUR-MARK-OUTSIDE-CATALOGUE-20260920. The
// overtime stepper used to carry `suffix="h"`, an hour mark written into the
// view instead of the catalogue, so no translator could reach it. Both the
// rendered unit and the source shape are pinned here.
const workload = {
  entries: [],
  stats: { enoughData: false, categories: [], tiles: {} },
  reminders: { available: false },
};

function renderView(lang) {
  return render(
    <LanguageProvider lang={lang}>
      <WorkloadView data={{ workload }} onLogWork={vi.fn()} onSaveReminder={vi.fn()} />
    </LanguageProvider>,
  );
}

describe.each([
  ["en", "Worked overtime", "Overtime hours"],
  ["es", "Trabajé horas extra", "Horas extra"],
])("overtime stepper hour mark (%s)", (lang, checkRowLabel, stepperLabel) => {
  it("renders the catalogue hour unit, not a literal pinned in the view", () => {
    expect(catalogue[lang]["mwl.hrsShort"]).toBeTruthy();
    renderView(lang);
    fireEvent.click(screen.getByRole("button", { name: checkRowLabel }));
    const stepper = screen.getByRole("group", { name: stepperLabel });
    expect(stepper.querySelector(".mwl-stepval").textContent).toBe(`1${catalogue[lang]["mwl.hrsShort"]}`);
  });
});

describe("WorkloadView Stepper suffixes", () => {
  it("passes every Stepper suffix through the catalogue", () => {
    const src = readFileSync(resolve(process.cwd(), "src/views/WorkloadView.jsx"), "utf8");
    const suffixes = [...src.matchAll(/suffix=(\{[^}]*\}|"[^"]*")/g)].map((m) => m[1]);
    expect(suffixes.length).toBeGreaterThan(0);
    for (const suffix of suffixes) {
      expect(suffix, `WorkloadView pins a literal Stepper suffix ${suffix}; read it from the catalogue with t()`).toMatch(/^\{t\(/);
    }
  });
});
