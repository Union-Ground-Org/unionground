// BUG-UG-SURVEY-CHOICE-QUESTIONS-NOT-SAVED-20261030 (#6552): the
// "Options, one per line" box re-parsed its text on every keystroke, so a
// typed line break or space vanished before the next character and every
// choice question reached save_organization_survey_draft with one option
// ("YesNoNotsure"), which the database refused with HTTP 400. These cases
// type one character at a time, the way a person does, instead of setting
// the whole value at once (which is how the older UI cases missed it).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";

const staffSnapshot = {
  surveys: [], livePolls: [], pulsePrompts: [], channels: [], members: [],
  presence: { online: 0 }, delivery: {},
};

function staffClient({ saveError = null, draft = null } = {}) {
  return {
    rpc: vi.fn(async (name, args) => {
      if (name === "get_staff_engagement_snapshot") return { data: { ...staffSnapshot, surveys: draft ? [{ id: draft.id, title: draft.title, status: "draft" }] : [] }, error: null };
      if (name === "get_organization_survey_draft") return { data: draft, error: null };
      if (name === "save_organization_survey_draft") return saveError ? { data: null, error: saveError } : { data: { id: "saved-survey", ...args.p_draft }, error: null };
      if (name === "get_weekly_question_selection_workspace") return { data: { policy: {}, items: [] }, error: null };
      return { data: {}, error: null };
    }),
  };
}

function typeInto(field, text) {
  for (const character of text) fireEvent.change(field, { target: { value: field.value + character } });
}

async function openNewSurvey(client) {
  render(<StaffEngagement client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "New survey" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Shift bid survey" } });
}

function choiceQuestion(number, type, prompt) {
  if (number > 1) fireEvent.click(screen.getByRole("button", { name: "Add question" }));
  const group = screen.getByRole("group", { name: `Question ${number}` });
  fireEvent.change(within(group).getByLabelText("Prompt"), { target: { value: prompt } });
  fireEvent.change(within(group).getByLabelText("Type"), { target: { value: type } });
  return within(group).getByLabelText(/Options, one per line/);
}

function savedDraft(client) {
  return client.rpc.mock.calls.find(([name]) => name === "save_organization_survey_draft")?.[1].p_draft;
}

describe("survey choice questions keep their typed options", () => {
  it("keeps line breaks and spaces while typing, and saves one-choice, multiple-choice and dropdown questions with three options", async () => {
    const client = staffClient();
    await openNewSurvey(client);
    const types = [["radio", "Which shift do you want?"], ["checkbox", "Which days work?"], ["dropdown", "Which garage?"]];
    for (const [at, [type, prompt]] of types.entries()) {
      const options = choiceQuestion(at + 1, type, prompt);
      typeInto(options, "Yes\n");
      expect(options.value).toBe("Yes\n");
      typeInto(options, "No\nNot ");
      expect(options.value).toBe("Yes\nNo\nNot ");
      typeInto(options, "sure");
      expect(options.value).toBe("Yes\nNo\nNot sure");
    }
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(savedDraft(client)).toBeTruthy());
    const questions = savedDraft(client).questions;
    expect(questions.map(({ type, options }) => ({ type, options }))).toEqual([
      { type: "radio", options: ["Yes", "No", "Not sure"] },
      { type: "checkbox", options: ["Yes", "No", "Not sure"] },
      { type: "dropdown", options: ["Yes", "No", "Not sure"] },
    ]);
    // The raw box text is editor state only; it never reaches the database.
    for (const question of questions) expect(question).not.toHaveProperty("optionsText");
    expect(await screen.findByText("Survey draft saved.")).toBeInTheDocument();
  });

  it("names the question, field and reason and sends nothing when a choice question has one option", async () => {
    const client = staffClient();
    await openNewSurvey(client);
    const first = screen.getByRole("group", { name: "Question 1" });
    fireEvent.change(within(first).getByLabelText("Prompt"), { target: { value: "How are we doing?" } });
    const options = choiceQuestion(2, "dropdown", "Which garage?");
    typeInto(options, "Central");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText("Survey could not be saved. Question 2, Options, one per line: a choice question needs 2 to 20 options, one per line.")).toBeInTheDocument();
    expect(savedDraft(client)).toBeUndefined();
  });

  it("reads a database refusal into the field and reason instead of a bare failure", async () => {
    const client = staffClient({ saveError: { code: "22023", message: "survey option values must be unique" } });
    await openNewSurvey(client);
    typeInto(choiceQuestion(1, "radio", "Which shift?"), "Day\nNight");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText("Survey could not be saved. Options, one per line: each option must be different.")).toBeInTheDocument();
  });

  it("keeps the plain failure line for a refusal that is not an authoring rule", async () => {
    const client = staffClient({ saveError: { code: "42501", message: "not authorized" } });
    await openNewSurvey(client);
    typeInto(choiceQuestion(1, "radio", "Which shift?"), "Day\nNight");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText("Survey could not be saved.")).toBeInTheDocument();
  });

  it("shows a saved draft's options one per line and clears the box when the type stops taking options", async () => {
    const draft = {
      id: "draft-1", title: "Shift bid survey", description: "", privacyMinResponses: 3, status: "draft",
      questions: [{ id: "q1", clientKey: "question-a", type: "radio", label: "Which shift?", required: true, options: ["Day", "Night"], sectionKey: "section-1" }],
    };
    const client = staffClient({ draft });
    render(<StaffEngagement client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const group = await screen.findByRole("group", { name: "Question 1" });
    const options = within(group).getByLabelText(/Options, one per line/);
    expect(options.value).toBe("Day\nNight");
    fireEvent.change(within(group).getByLabelText("Type"), { target: { value: "checkbox" } });
    expect(within(group).getByLabelText(/Options, one per line/).value).toBe("Day\nNight");
    fireEvent.change(within(group).getByLabelText("Type"), { target: { value: "text" } });
    fireEvent.change(within(group).getByLabelText("Type"), { target: { value: "dropdown" } });
    expect(within(group).getByLabelText(/Options, one per line/).value).toBe("");
  });
});
