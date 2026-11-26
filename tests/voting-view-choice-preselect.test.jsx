// Tapped-option preselection for the member Voice screen
// (UX-UG-VOTING-BALLOT-OPTION-BUTTONS-DROP-TAPPED-CHOICE-20260920).
// Every option surface — the primary ballot hero, additional ballot rows and
// pulse cards — must open the confirmation dialog with the exact tapped
// option already selected, every configured hero option (including a third
// choice such as Abstain) must be reachable from the hero row, and nothing
// may submit before the member explicitly activates the confirmation control.
// The hero row must also wrap its full option set at phone widths (up to 20
// configured choices) instead of squeezing them into one non-wrapping row.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { ChoiceDialog } from "../src/components/Dialogs.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { applyDeviceParityState, clearDeviceParityState } from "../src/lib/deviceParity.js";
import { VotingView } from "../src/views/VotingView.jsx";
import { primeDemoHat } from "./helpers/demoHat.js";

const primaryBallot = fallbackData.planItems.find((item) => item.kind === "ballot" && !item.closed);
const pulse = fallbackData.planItems.find((item) => item.kind === "pulse" && !item.closed);
// A second open ballot exercises the additional-ballot option row; the
// primary hero stays the first open ballot.
const additionalBallot = { ...primaryBallot, id: "ballot-extra", title: "Extra contract", receiptCode: null };

const data = {
  ...fallbackData,
  planItems: [...fallbackData.planItems, additionalBallot],
};

function renderVoting(onPlanAction) {
  return render(
    <LanguageProvider lang="en">
      <VotingView data={data} demo onPlanAction={onPlanAction} />
    </LanguageProvider>,
  );
}

function renderChoiceDialog(item, onSubmit = vi.fn()) {
  return {
    onSubmit,
    view: render(
      <LanguageProvider lang="en">
        <ChoiceDialog item={item} onClose={vi.fn()} onSubmit={onSubmit} />
      </LanguageProvider>,
    ),
  };
}

afterEach(() => {
  clearDeviceParityState();
});

describe("VotingView tapped-option surfaces", () => {
  it("renders every configured hero option, including the third choice", () => {
    const view = renderVoting(vi.fn());
    const hero = view.container.querySelector(".voting-hero");
    const buttons = [...hero.querySelectorAll("button")].filter((button) =>
      (primaryBallot.options || []).some((option) => option.label === button.textContent),
    );
    expect(buttons).toHaveLength(primaryBallot.options.length);
    for (const option of primaryBallot.options) {
      expect(buttons.some((button) => button.textContent === option.label)).toBe(true);
    }
    view.unmount();
  });

  it("preselects the exact option tapped on the primary ballot hero", () => {
    const onPlanAction = vi.fn();
    const view = renderVoting(onPlanAction);
    const abstain = (primaryBallot.options || []).find((option) => /abstain/i.test(option.label));
    const button = [...view.container.querySelectorAll(".voting-hero__actions button")]
      .find((candidate) => candidate.textContent === abstain.label);
    fireEvent.click(button);
    expect(onPlanAction).toHaveBeenCalledTimes(1);
    const item = onPlanAction.mock.calls[0][0];
    expect(item.id).toBe(primaryBallot.id);
    expect(item.selectedOption).toBe(abstain.id);
    view.unmount();
  });

  it("preselects the exact option tapped on an additional ballot row", () => {
    const onPlanAction = vi.fn();
    const view = renderVoting(onPlanAction);
    const row = view.container.querySelector(".voting-extra");
    const option = (additionalBallot.options || [])[1];
    const button = [...row.querySelectorAll(".voting-option")].find((candidate) => candidate.textContent.includes(option.label));
    fireEvent.click(button);
    expect(onPlanAction).toHaveBeenCalledTimes(1);
    const item = onPlanAction.mock.calls[0][0];
    expect(item.id).toBe(additionalBallot.id);
    expect(item.selectedOption).toBe(option.id);
    view.unmount();
  });

  it("preselects the exact option tapped on a pulse card", () => {
    const onPlanAction = vi.fn();
    const view = renderVoting(onPlanAction);
    const card = view.container.querySelector(`#survey-${pulse.id}`);
    const option = (pulse.options || [])[2];
    const button = [...card.querySelectorAll(".voting-pulse__opt")].find((candidate) => candidate.textContent === option.label);
    fireEvent.click(button);
    expect(onPlanAction).toHaveBeenCalledTimes(1);
    const item = onPlanAction.mock.calls[0][0];
    expect(item.id).toBe(pulse.id);
    expect(item.selectedOption).toBe(option.id);
    view.unmount();
  });
});

describe("ChoiceDialog tapped-option preselection", () => {
  it("opens with the tapped option checked and does not submit before explicit confirmation", () => {
    const option = (primaryBallot.options || [])[2];
    const item = { ...primaryBallot, selectedOption: option.id };
    const { onSubmit, view } = renderChoiceDialog(item);
    const radio = view.container.querySelector(`input[type="radio"][value="${option.id}"]`);
    expect(radio).toBeTruthy();
    expect(radio.checked).toBe(true);
    // Opening the dialog is not a cast: the confirmation control is the only
    // submission path.
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(view.container.querySelector(".dialog-primary"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(option.id);
    view.unmount();
  });

  it("lets the tapped option win over a stale persisted draft selection", () => {
    const tapped = (primaryBallot.options || [])[2];
    const stale = (primaryBallot.options || [])[0];
    // Simulate an earlier dialog session persisting a different selection.
    applyDeviceParityState(`choice.${primaryBallot.id}.selected`, stale.id);
    const { onSubmit, view } = renderChoiceDialog({ ...primaryBallot, selectedOption: tapped.id });
    const radio = view.container.querySelector(`input[type="radio"][value="${tapped.id}"]`);
    expect(radio.checked).toBe(true);
    const staleRadio = view.container.querySelector(`input[type="radio"][value="${stale.id}"]`);
    expect(staleRadio.checked).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps the confirmation control disabled until a selection exists on an unpreselected open", () => {
    const { onSubmit, view } = renderChoiceDialog({ ...primaryBallot, selectedOption: "" });
    const confirm = view.container.querySelector(".dialog-primary");
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onSubmit).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("hero option row phone layout contract", () => {
  // jsdom performs no layout, so the 390px multi-option behaviour is pinned
  // as a stylesheet contract (same pattern as task-templates-responsive).
  const styles = readFileSync("src/styles.css", "utf8");

  it("wraps the full hero option set at phone widths with touch-target floors", () => {
    expect(styles).toMatch(/\.voting-hero__actions \{[^}]*flex-wrap: wrap/s);
    expect(styles).toMatch(
      /\.voting-hero__approve, \.voting-hero__reject \{[^}]*flex: 1 1 140px; min-width: 96px; min-height: 50px/s,
    );
    expect(styles).not.toContain(".voting-hero__actions { display: flex; gap: 9px; margin-top: 12px; }");
  });

  it("feeds every configured option into the wrapping hero row", () => {
    // CampaignsView permits up to 20 options; a representative wide ballot
    // must render every choice inside the actions container so the wrapping
    // rule can lay them out at 390px.
    const wideOptions = Array.from({ length: 8 }, (_, index) => ({ id: `opt-${index}`, label: `Choice ${index + 1}` }));
    const wideData = {
      ...data,
      planItems: data.planItems.map((item) => (item.id === primaryBallot.id ? { ...item, options: wideOptions } : item)),
    };
    const view = render(
      <LanguageProvider lang="en">
        <VotingView data={wideData} demo onPlanAction={vi.fn()} />
      </LanguageProvider>,
    );
    const actions = view.container.querySelector(".voting-hero__actions");
    const buttons = [...actions.querySelectorAll("button")];
    expect(buttons).toHaveLength(wideOptions.length);
    for (const option of wideOptions) {
      expect(buttons.some((button) => button.textContent === option.label)).toBe(true);
    }
    view.unmount();
  });
});

describe("App voting route tapped-option wiring", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });

  it("opens the live ChoiceDialog with the tapped third hero option already selected and does not submit until confirmation", async () => {
    const abstain = (primaryBallot.options || []).find((option) => /abstain/i.test(option.label));
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/voting?demo=1");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: abstain.label }));
    const dialog = await screen.findByRole("dialog");
    const radio = within(dialog).getByRole("radio", { name: abstain.label });
    expect(radio).toBeChecked();
    expect(radio).toHaveAttribute("value", abstain.id);
    expect(within(dialog).getByRole("radio", { name: primaryBallot.options[0].label })).not.toBeChecked();
    expect(screen.queryByText(/preview receipt/i)).not.toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Submit vote" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await screen.findByText(/Vote recorded — preview receipt/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
