// BUG-UG-ONE-CATCH-ALL-LINE-FOR-EVERY-REFUSAL-20261122 (#9464, W5-8):
// a refused survey save names the cause beside the buttons, never the server's
// sentence, and names each required question still unanswered and its section.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberEngagement } from "../src/features/engagement/MemberEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApi.js";

const client = () => ({ channel: vi.fn(() => ({ on: vi.fn(() => ({ subscribe: vi.fn(() => ({})) })) })), removeChannel: vi.fn() });
const refusal = (code, message) => new MemberApiError("Submit survey", { code, message });
const MISSING = "required survey questions are missing";

function snapshot(answers) {
  return {
    surveys: [{ id: "survey-1", title: "Workplace check", cadence: "one_off", session: { answers }, questions: [
      // No section key or title: the first section is "Questions".
      { id: "name", type: "text", label: "Your worksite", required: true },
      { id: "branch", type: "yes_no", label: "Follow up?" },
      { id: "why", type: "text", label: "Why", required: true, branchParentId: "branch", branchValue: "yes" },
      { id: "topics", type: "checkbox", label: "Topics that matter", required: true, options: ["Pay", "Safety"], sectionKey: "more", sectionTitle: "Priorities" },
    ] }],
  };
}

// Opens the survey and, unless told not to, moves to its second section.
async function openSurvey({ lang = "en", answers = {}, next = true } = {}) {
  vi.spyOn(engagementApi, "loadMember").mockResolvedValue(snapshot(answers));
  render(<LanguageProvider lang={lang}><MemberEngagement client={client()} organizationId="org-1" /></LanguageProvider>);
  await screen.findByTestId("member-engagement");
  const survey = screen.getByRole("heading", { name: "Workplace check" }).closest("form");
  if (next) {
    fireEvent.click(within(survey).getByRole("button", { name: lang === "es" ? "Guardar y continuar" : "Save and continue" }));
    await within(survey).findByText(/Topics that matter/);
  }
  return survey;
}

async function submitRefused(survey, code, message) {
  engagementApi.submitSurveySession.mockRejectedValueOnce(refusal(code, message));
  fireEvent.submit(survey);
  return within(survey).findByRole("alert");
}

beforeEach(() => { for (const method of ["saveSurveySession", "submitSurveySession", "heartbeat"]) vi.spyOn(engagementApi, method).mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("a refused survey says why", () => {
  it("lists each unanswered required question and section", async () => {
    const survey = await openSurvey();
    expect(screen.getByText("Progress saved.")).toBeInTheDocument();
    const alert = await submitRefused(survey, "22023", MISSING);
    // The earlier "Progress saved." is not left beside a later refusal.
    expect(screen.queryByText("Progress saved.")).not.toBeInTheDocument();
    expect(alert).toHaveTextContent("These required questions (marked *) still need an answer");
    expect(within(alert).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Your worksite, in Questions", "Topics that matter, in Priorities"]);
    expect(alert).not.toHaveTextContent(/required survey questions are missing|Survey could not be submitted/);
    expect(within(survey).getByLabelText(/Your worksite/)).toBeInTheDocument();
  });

  it("drops answered or hidden questions from the list", async () => {
    const survey = await openSurvey({ answers: { branch: "yes", topics: ["Pay"] }, next: false });
    const alert = await submitRefused(survey, "22023", MISSING);
    const listed = () => within(alert).queryAllByRole("listitem").map((item) => item.textContent);
    expect(listed()).toEqual(["Your worksite, in Questions", "Why, in Questions"]);
    fireEvent.click(within(survey).getByLabelText("No"));
    expect(listed()).toEqual(["Your worksite, in Questions"]);
    fireEvent.change(within(survey).getByLabelText(/Your worksite/), { target: { value: "North" } });
    expect(within(survey).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists them in Spanish", async () => {
    const alert = await submitRefused(await openSurvey({ lang: "es" }), "22023", MISSING);
    expect(alert).toHaveTextContent("Estas preguntas obligatorias (marcadas con *) aún necesitan respuesta");
    expect(within(alert).getAllByRole("listitem")[1]).toHaveTextContent("Topics that matter, en Priorities");
  });

  it.each([
    ["P0001", "survey session already submitted", /^This survey was already submitted/],
    ["P0002", "not found", /^This survey is closed/],
    ["22023", "answer is not an available option", /^One of your answers is no longer a choice/],
  ])("names %s %s", async (code, reply, copy) => {
    expect((await submitRefused(await openSurvey(), code, reply)).textContent).toMatch(copy);
  });

  it("missing but unknown which; too-long text neutral", async () => {
    const survey = await openSurvey({ answers: { name: "North", topics: ["Pay"] }, next: false });
    expect((await submitRefused(survey, "22023", MISSING)).textContent)
      .toMatch(/^A required question \(marked \*\) still needs an answer/);
    engagementApi.submitSurveySession.mockRejectedValueOnce(refusal("22023", "invalid text answer"));
    fireEvent.submit(survey);
    await waitFor(() => expect(within(survey).getByRole("alert").textContent).toBe("Survey could not be submitted."));
  });

  it("lost reply is unconfirmed; unknown reply neutral", async () => {
    const survey = await openSurvey({ next: false });
    engagementApi.saveSurveySession.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(within(survey).getByRole("button", { name: "Save and continue" }));
    expect((await within(survey).findByRole("alert")).textContent)
      .toMatch(/^There was no reply, so it is not known whether your answers were saved\./);
    engagementApi.saveSurveySession.mockRejectedValueOnce(refusal("22023", "invalid multiple-choice answer"));
    fireEvent.click(within(survey).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(within(survey).getByRole("alert").textContent).toBe("Survey progress could not be saved."));
  });
});
