import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkView } from "../src/views/WorkView.jsx";

function renderWork(lang = "en") {
  return render(
    <LanguageProvider lang={lang}>
      <WorkView data={fallbackData} onProfile={() => {}} onAssistant={() => {}} />
    </LanguageProvider>,
  );
}

describe("organizing Work surface", () => {
  it("shows safe task identifiers, status, and blocked state", () => {
    renderWork();
    expect(screen.getByRole("heading", { name: "My work" })).toBeInTheDocument();
    expect(screen.getByText("PSG-104")).toBeInTheDocument();
    expect(screen.getByText("Confirm Thursday meeting room")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText(/Task titles stay general/)).toBeInTheDocument();
  });

  it("filters by status and search without hiding the empty-state explanation", () => {
    renderWork();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("PSG-123")).toBeInTheDocument();
    expect(screen.queryByText("PSG-104")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter organizing work" }), { target: { value: "missing" } });
    expect(screen.getByText("No work matches this filter.")).toBeInTheDocument();
  });

  it("keeps the Work navigation label translated", () => {
    renderWork("es");
    expect(screen.getByRole("heading", { name: "Mi trabajo" })).toBeInTheDocument();
    expect(screen.getByText("Trabajo de campaña")).toBeInTheDocument();
  });
});
