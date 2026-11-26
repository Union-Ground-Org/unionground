// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseNoteComposer } from "../src/components/CaseMentions.jsx";
import { matchMentionCandidates, reconcileMentionSelections } from "../src/lib/caseMentions.js";

afterEach(cleanup);
const people = [
  { userId: "first", fullName: "Alex Rivera" },
  { userId: "selected", fullName: "Alex Rivera" },
];
const t = (key) => key;
function chooseSecond(onSubmit = vi.fn().mockResolvedValue({})) {
  const view = render(<CaseNoteComposer caseId="case-a" candidates={people} onSubmit={onSubmit} t={t} />);
  const box = screen.getByRole("combobox");
  fireEvent.change(box, { target: { value: "@Alex" } });
  fireEvent.click(screen.getByRole("option", { name: "@Alex Rivera (selected)" }));
  return { ...view, box, onSubmit };
}
async function submit(onSubmit, body, ids) {
  fireEvent.click(screen.getByRole("button", { name: "coordinator.addNote" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("case-a", body, ids));
}

describe("case mention recipient identity", () => {
  it("submits the selected second person even after the directory reorders", async () => {
    const { rerender, onSubmit } = chooseSecond();
    rerender(<CaseNoteComposer caseId="case-a" candidates={[...people].reverse()} onSubmit={onSubmit} t={t} />);
    // Reverse twice: submission must not depend on either directory order.
    rerender(<CaseNoteComposer caseId="case-a" candidates={people} onSubmit={onSubmit} t={t} />);
    await submit(onSubmit, "@Alex Rivera", ["selected"]);
  });

  it("retains selection when prose is inserted before and after it", async () => {
    const { box, onSubmit } = chooseSecond();
    fireEvent.change(box, { target: { value: "Please @Alex Rivera " } });
    fireEvent.change(box, { target: { value: "Please @Alex Rivera review" } });
    await submit(onSubmit, "Please @Alex Rivera review", ["selected"]);
  });

  it("withdraws edited or deleted identity and does not restore it from ambiguous text", async () => {
    const { box, onSubmit } = chooseSecond();
    fireEvent.change(box, { target: { value: "@Alex River " } });
    fireEvent.change(box, { target: { value: "@Alex Rivera " } });
    await submit(onSubmit, "@Alex Rivera", []);
  });

  it("withdraws a selected person who leaves the candidate directory", async () => {
    const { rerender, onSubmit } = chooseSecond();
    rerender(<CaseNoteComposer caseId="case-a" candidates={[people[0]]} onSubmit={onSubmit} t={t} />);
    await submit(onSubmit, "@Alex Rivera", []);
  });

  it("never guesses an ambiguous typed name but retains unique longest-name matching", () => {
    expect(matchMentionCandidates("@Alex Rivera", people)).toEqual([]);
    expect(matchMentionCandidates("@Alex Rivera", [...people].reverse())).toEqual([]);
    const unique = [{ userId: "short", fullName: "Alex" }, people[1]];
    expect(matchMentionCandidates("@Alex Rivera and @Alex", unique)).toEqual(["short", "selected"]);
    expect(matchMentionCandidates("ordinary prose", people)).toEqual([]);
  });

  it("preserves two separate same-named selections and clears ambiguous repeated-text edits", async () => {
    const { box, onSubmit } = chooseSecond();
    fireEvent.change(box, { target: { value: "@Alex Rivera and @Alex" } });
    fireEvent.click(screen.getByRole("option", { name: "@Alex Rivera (first)" }));
    await submit(onSubmit, "@Alex Rivera and @Alex Rivera", ["first", "selected"]);
    const body = "@Alex Rivera @Alex Rivera ";
    const selections = [
      { start: 0, end: 12, userId: "first", fullName: "Alex Rivera" },
      { start: 13, end: 25, userId: "selected", fullName: "Alex Rivera" },
    ];
    expect(reconcileMentionSelections(body, "@Alex Rivera ", selections)).toEqual([]);
    expect(reconcileMentionSelections(body, "gone", selections)).toEqual([]);
  });

  it("keeps explicit identity through an unchanged body", () => {
    const body = "@Alex Rivera ";
    const selections = [{ start: 0, end: 12, userId: "selected", fullName: "Alex Rivera" }];
    const retained = reconcileMentionSelections(body, body, selections);
    expect(matchMentionCandidates(body, people, retained)).toEqual(["selected"]);
  });

  it("keeps the recipient through caret moves, Tab and unavailable selection positions", async () => {
    const { box, onSubmit } = chooseSecond();
    fireEvent.change(box, { target: { value: "@Alex Rivera and @Al" } });
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box).toHaveValue("@Alex Rivera and @Al");
    fireEvent.keyUp(box);
    fireEvent.click(box);
    Object.defineProperty(box, "selectionStart", { configurable: true, get: () => null });
    fireEvent.keyUp(box);
    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(box, { target: { value: "@Alex Rivera and notes" } });
    await submit(onSubmit, "@Alex Rivera and notes", ["selected"]);
  });
});
