import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { VotingView } from "../src/views/VotingView.jsx";

afterEach(() => {
  clearDeviceParityState();
});

const surfaces = [
  { name: "phone", desktop: false, field: "Suggest a poll question", submit: "Send" },
  { name: "desktop", desktop: true, field: "Suggest a poll", submit: "Submit for review" },
];

function renderVoting(desktop, onSuggestPoll) {
  return render(
    <LanguageProvider lang="en">
      <VotingView data={fallbackData} demo desktop={desktop} onPlanAction={vi.fn()} onSuggestPoll={onSuggestPoll} />
    </LanguageProvider>,
  );
}

describe.each(surfaces)("VotingView poll suggestion on $name", ({ desktop, field, submit }) => {
  it("offers another suggestion after a handoff and starts it empty", async () => {
    const onSuggestPoll = vi.fn().mockResolvedValue(undefined);
    renderVoting(desktop, onSuggestPoll);
    fireEvent.change(screen.getByRole("textbox", { name: field }), { target: { value: "Parking survey" } });
    fireEvent.click(screen.getByRole("button", { name: submit }));
    fireEvent.click(await screen.findByRole("button", { name: "Suggest another poll" }));
    expect(screen.getByRole("textbox", { name: field })).toHaveValue("");
    expect(onSuggestPoll).toHaveBeenCalledWith("Parking survey", "chapter");
  });

  it("keeps the text when the handoff is rejected", async () => {
    const onSuggestPoll = vi.fn().mockRejectedValue(new Error("offline"));
    renderVoting(desktop, onSuggestPoll);
    fireEvent.change(screen.getByRole("textbox", { name: field }), { target: { value: "Parking survey" } });
    fireEvent.click(screen.getByRole("button", { name: submit }));
    await waitFor(() => expect(onSuggestPoll).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: submit })).not.toBeDisabled());
    expect(screen.getByRole("textbox", { name: field })).toHaveValue("Parking survey");
    expect(screen.queryByRole("button", { name: "Suggest another poll" })).toBeNull();
  });
});
