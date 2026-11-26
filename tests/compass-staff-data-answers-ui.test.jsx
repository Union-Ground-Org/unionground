// REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001: the "Our numbers" toggle.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

function renderAssistant(props) {
  return render(<LanguageProvider lang="en"><Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn().mockResolvedValue(null)} {...props} /></LanguageProvider>);
}

describe("Compass staff figures toggle", () => {
  it("is absent unless the staff hat and the organization allow it", () => {
    renderAssistant({ suggestions: ["How do I file a grievance?"] });
    expect(screen.queryByRole("button", { name: t("en", "compass.numbers.toggle") })).toBeNull();
  });

  it("pre-selects for a figure suggestion and sends the staff mode", async () => {
    const onSend = vi.fn().mockResolvedValue(null);
    renderAssistant({ staffDataAvailable: true, suggestions: ["What's our grievance win rate?", "Walk me through the non-selection grievance process"], onSend });
    const toggle = screen.getByRole("button", { name: t("en", "compass.numbers.toggle") });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Walk me through the non-selection grievance process" }));
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "What's our grievance win rate?" }));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(t("en", "compass.numbers.note"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("en", "guide.send") }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("What's our grievance win rate?", null, [], { mode: "staff_data" }));
  });

  it("sends an ordinary question when the toggle is off and explains a refusal in figures mode", async () => {
    const onSend = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "feature_disabled" }));
    renderAssistant({ staffDataAvailable: true, onSend });
    fireEvent.change(screen.getByRole("textbox", { name: t("en", "compass.askAria") }), { target: { value: "How many members?" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.numbers.toggle") }));
    fireEvent.click(screen.getByRole("button", { name: t("en", "guide.send") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "compass.numbers.feature_disabled"));
    expect(onSend).toHaveBeenCalledWith("How many members?", null, [], { mode: "staff_data" });
  });
});

describe("Compass keeps Send focused while a question is answered (record 8435)", () => {
  it("keeps Send focused while the answer is requested, and asks once", async () => {
    const onSend = vi.fn(async () => null);
    renderAssistant({ suggestions: ["Walk me through the non-selection grievance process"], onSend });
    fireEvent.click(screen.getByRole("button", { name: "Walk me through the non-selection grievance process" }));
    await expectHeldWriteFocus(onSend, screen.getByRole("button", { name: t("en", "guide.send") }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
