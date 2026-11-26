import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FormsView } from "../src/views/FormsView.jsx";

// UX-UG-FORMS-SILENT-200-CHARACTER-CUT-AND-DOUBLE-EDITOR-20261111: the
// grievance summary stopped at 200 characters without saying so.
function grievance(lang) {
  render(<LanguageProvider lang={lang}><FormsView
    data={{ member: { initials: "FT" }, forms: [] }}
    focus={{ templateKey: "grievance" }}
    onSaveDraft={vi.fn().mockResolvedValue("fixture-draft")} onSubmit={vi.fn()}
  /></LanguageProvider>);
}

describe("a limited form field shows its limit and a count", () => {
  it.each([
    ["en", "Issue summary", "0 of 200 characters", "12 of 200 characters", "Limit reached: 200 characters."],
    ["es", "Resumen del asunto", "0 de 200 caracteres", "12 de 200 caracteres", "Llegaste al límite de 200 caracteres."],
  ])("counts as you type and says when the limit is reached (%s)", (lang, label, empty, typed, reached) => {
    grievance(lang);
    const summary = screen.getByRole("textbox", { name: label });
    expect(summary).toHaveAttribute("maxlength", "200");
    // The count is visible, sits with this field, and is part of its description.
    const count = () => document.getElementById(summary.getAttribute("aria-describedby").split(" ")[1]);
    expect(count()).toBeVisible();
    expect(count()).toHaveTextContent(empty);
    expect(summary).toHaveAccessibleDescription(expect.stringContaining(empty));

    fireEvent.change(summary, { target: { value: "Fixture text" } });
    expect(count()).toHaveTextContent(typed);

    fireEvent.change(summary, { target: { value: "x".repeat(200) } });
    expect(count().textContent.startsWith(reached)).toBe(true);
    expect(count()).toHaveAttribute("aria-live", "polite");
    expect(summary).toHaveAccessibleDescription(expect.stringContaining(reached));
  });

  it("puts no count on fields without a limit", () => {
    grievance("en");
    for (const box of screen.getAllByRole("textbox")) {
      const max = box.getAttribute("maxlength");
      if (max === null) expect(box.getAttribute("aria-describedby")?.split(" ")).toHaveLength(1);
      else expect(box.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    }
  });
});
