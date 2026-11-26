import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { WORKLOAD_CATEGORY_KEYS } from "../src/lib/workloadCategories.js";
import { WorkloadView } from "../src/views/WorkloadView.jsx";

function renderWorkload(lang) {
  render(
    <LanguageProvider lang={lang}>
      <WorkloadView data={structuredClone(fallbackData)} onLogWork={async () => {}} />
    </LanguageProvider>,
  );
}

// BUG-UG-WORKLOAD-SHOWS-ONE-OFFICES-PERFORMANCE-STANDARDS-TO-EVERY-UNION-20261122
// (#9497): the Stats tab used to end with a fixed "DDS performance standards"
// card written for one state disability office (SSA program rules, an 87%
// accuracy minimum, PER ratings), shown to every organization with no setting
// behind it. It is retired, and the Submit tab's "performance review (PER)"
// line names no office's rating system: no tab of the page shows any of that
// office's terms, in either language.
const RETIRED_CARD_TEXT = [
  /performance standards/i,
  /Estándares de desempeño/i,
  /Accuracy minimum/i,
  /Precisión mínima/i,
  /\bSSA\b/,
  /\bDDS\b/,
  /\bPER\b/,
  /87\s?%/,
];
const fictionalStats = {
  enoughData: true,
  submittersBand: 25,
  categories: WORKLOAD_CATEGORY_KEYS.map((key) => ({ key, avg: 2, median: 2, p90: 3 })),
  tiles: { pctFullTime: 60, pctPartTime: 40, avgOtHours: 1 },
};
const fictionalCounts = Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map((key, index) => [key, index + 1]));

describe("workload page for any organization", () => {
  it.each(["en", "es"])("shows no fixed performance-standards card and no SSA, DDS, PER or 87% on any tab in %s", (lang) => {
    const { container } = render(
      <LanguageProvider lang={lang}>
        <WorkloadView
          data={{ workload: { entries: [{ id: "fictional-e1", receipt: "R1", counts: fictionalCounts, meta: "", note: "", dateLabel: "Nov 2" }], stats: fictionalStats, reminders: { available: false } } }}
          onLogWork={async () => {}}
          onSaveReminder={async () => {}}
        />
      </LanguageProvider>,
    );
    for (const tab of ["submit", "history", "stats", "reminders"]) {
      fireEvent.click(screen.getByRole("button", { name: t(lang, `workload.tab.${tab}`) }));
      // The Stats tab renders its full body (tiles and the comparison card), where the card used to sit.
      if (tab === "stats") expect(container.querySelector(".mwl-tiles")).not.toBeNull();
      for (const pattern of RETIRED_CARD_TEXT) expect(container.textContent).not.toMatch(pattern);
    }
  });
});

describe("workload leave chip groups", () => {
  it.each([
    ["en", "Sick", "Leave this period", "Planned or unplanned leave"],
    ["es", "Enfermedad", "Licencia este período", "Licencia planificada o no planificada"],
  ])("give the leave type and timing rows distinct names in %s", (lang, sick, typeName, timingName) => {
    renderWorkload(lang);
    fireEvent.click(screen.getByRole("button", { name: sick }));

    const groups = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(new Set(groups).size).toBe(groups.length);
    expect(screen.getByRole("group", { name: typeName })).toContainElement(screen.getByRole("button", { name: sick }));
    const timing = screen.getByRole("group", { name: timingName });
    expect(timing.querySelectorAll("button")).toHaveLength(2);
  });
});
