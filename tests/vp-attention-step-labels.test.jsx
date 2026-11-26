import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VpView } from "../src/views/VpView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// Locale-neutral get_vp_overview attention rows. Titles and custom step names
// are organization-authored and must survive both languages unchanged.
const attention = [
  { id: "c1", reference: "G-1", title: "Hearing not scheduled", step: "Step 1", deadline: "2026-07-18", memberName: "Amina Cole" },
  { id: "c2", reference: "G-2", title: "Written response", step: "Step 2", deadline: "2026-07-19", memberName: "Amina Cole" },
  { id: "c3", reference: "G-3", title: "Panel review", step: "Step 3", deadline: "2026-07-20", memberName: "Amina Cole" },
  { id: "c4", reference: "G-4", title: "Arbitration window", step: "Step 4", deadline: "2026-07-21", memberName: "Amina Cole" },
  { id: "c5", reference: "G-5", title: "New filing", step: "Intake", deadline: "2026-07-22", memberName: "Amina Cole" },
  { id: "c6", reference: "G-6", title: "Step 2 hearing not scheduled", step: "Local fact-finding panel", deadline: "2026-07-23", memberName: "Amina Cole" },
];

function desk() {
  return {
    reviews: [],
    roster: [],
    overview: {
      memberCount: 4,
      newThisYear: 1,
      activeGrievances: attention.length,
      turnout: null,
      attention,
      upcomingEvents: [],
      priorities: [],
      membershipTrend: [],
    },
  };
}

function meta(id) {
  return (document.querySelector(`[data-attention-case="${id}"] p`)?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function Harness({ api }) {
  const [lang, setLang] = useState("en");
  return (
    <LanguageProvider lang={lang}>
      <button type="button" onClick={() => setLang((current) => (current === "en" ? "es" : "en"))}>Switch language</button>
      <VpView data={{ member: { initials: "TM" } }} api={api} />
    </LanguageProvider>
  );
}

describe("Campaign chair attention labels", () => {
  it("omits grievance steps in both languages and keeps authored titles and stored fields", async () => {
    const payload = desk();
    const stored = payload.overview.attention.map((item) => ({ id: item.id, step: item.step, title: item.title }));
    const api = { loadDesk: vi.fn().mockResolvedValue(payload), markReviewed: vi.fn() };
    render(<Harness api={api} />);

    expect(await screen.findByText("Hearing not scheduled")).toBeInTheDocument();
    const expectSummaries = (dateLabel) => {
      for (const [index, item] of payload.overview.attention.entries()) {
        const text = meta(item.id);
        expect(text).toContain(`G-${index + 1}`);
        expect(text).toMatch(dateLabel);
        expect(text).not.toMatch(/Step [1-4]|Paso [1-4]| · Intake| · Admisión|Local fact-finding panel/);
      }
      expect(screen.getByText("Step 2 hearing not scheduled")).toBeInTheDocument();
    };
    expectSummaries(/Due |Was due /i);
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expectSummaries(/Vence|Venció|Fecha límite/i);
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expectSummaries(/Due |Was due /i);
    expect(payload.overview.attention.map((item) => ({ id: item.id, step: item.step, title: item.title }))).toEqual(stored);
  });
});
