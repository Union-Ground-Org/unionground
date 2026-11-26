import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

function renderWorkload(props = {}, lang = "en") {
  const onLogWork = props.onLogWork || vi.fn().mockResolvedValue(null);
  render(
    <LanguageProvider lang={lang}>
      <WorkloadView
        data={{ member: { initials: "MV" }, workload: { entries: [], stats: { enoughData: false } } }}
        onProfile={vi.fn()}
        onAssistant={vi.fn()}
        onLogWork={onLogWork}
      />
    </LanguageProvider>,
  );
  return { onLogWork };
}

describe("workload stepper accessibility", () => {
  // Both buttons carried the bare category name, so a screen-reader user met
  // "Priority cases, button" twice with nothing to tell them apart — 20
  // ambiguous controls across this form's ten steppers.
  it("distinguishes the decrement and increment buttons by name", () => {
    renderWorkload();
    const stepper = screen.getByRole("group", { name: "Priority" });
    expect(within(stepper).getByRole("button", { name: "Decrease Priority" })).toBeInTheDocument();
    expect(within(stepper).getByRole("button", { name: "Increase Priority" })).toBeInTheDocument();
    expect(within(stepper).queryAllByRole("button", { name: "Priority" })).toEqual([]);
  });

  it("names them in the member's own language", () => {
    renderWorkload({}, "es");
    const stepper = screen.getByRole("group", { name: "Prioridad" });
    expect(within(stepper).getByRole("button", { name: "Reducir Prioridad" })).toBeInTheDocument();
    expect(within(stepper).getByRole("button", { name: "Aumentar Prioridad" })).toBeInTheDocument();
  });

  // Ten steppers meant ten simultaneous live regions competing on one screen.
  it("declares no per-stepper live region", () => {
    const { container } = render(
      <LanguageProvider lang="en">
        <WorkloadView
          data={{ member: { initials: "MV" }, workload: { entries: [], stats: { enoughData: false } } }}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          onLogWork={vi.fn()}
        />
      </LanguageProvider>,
    );
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
  });

  it("still steps the value", () => {
    renderWorkload();
    const stepper = screen.getByRole("group", { name: "Priority" });
    fireEvent.click(within(stepper).getByRole("button", { name: "Increase Priority" }));
    fireEvent.click(within(stepper).getByRole("button", { name: "Increase Priority" }));
    expect(stepper.textContent).toContain("2");
    fireEvent.click(within(stepper).getByRole("button", { name: "Decrease Priority" }));
    expect(stepper.textContent).toContain("1");
  });
});

describe("workload tab strip", () => {
  // Union Ground's routed workload tabs are toggle buttons in a named group
  // (aria-pressed, the AuthScreen pattern), not an ARIA tablist; only the
  // selected section is mounted.
  it("marks exactly the selected section and mounts only that section", () => {
    renderWorkload();
    const group = screen.getByRole("group", { name: "Workplace log" });
    expect(screen.queryAllByRole("tab")).toEqual([]);
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Submit", "History", "Stats", "Reminders"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(screen.queryByText("Anonymized collective stats")).toBeNull();

    fireEvent.click(within(group).getByRole("button", { name: "Stats" }));
    expect(within(group).getByRole("button", { name: "Stats" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Submit" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Anonymized collective stats")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit to secure ledger" })).toBeNull();
  });
});

describe("workload submission payload", () => {
  // The form always sent `subDetails: {}` for a capture surface that was never
  // built; memberApi already defaults the RPC argument to {}.
  it("does not send an always-empty subDetails object", async () => {
    const { onLogWork } = renderWorkload();
    fireEvent.click(screen.getByRole("button", { name: "Submit to secure ledger" }));
    await vi.waitFor(() => expect(onLogWork).toHaveBeenCalled());
    expect(onLogWork.mock.calls[0][0]).not.toHaveProperty("subDetails");
  });
});
