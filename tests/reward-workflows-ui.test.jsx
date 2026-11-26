import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mutationFailureNotice } from "../src/App.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { VoiceView } from "../src/views/VoiceView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const baseToday = {
  member: { id: "member-1", firstName: "Alex", roleLine: "Member", sinceYear: 2024, chapterId: "dds" },
  weekly: { done: 0, goal: 3 },
  planItems: [],
  cases: [],
  tasks: [],
  events: [],
  metrics: { openCases: 0 },
};

// A Union Ground-shaped snapshot still carrying the retired reward-backed
// chapter cards. Union Ground has no points economy and no public chapter
// directory, so Home must not render them even if a stale field arrives.
const staleRewardToday = {
  ...baseToday,
  rewardsCatalog: { rules: [], tiers: [] },
  rewardChapterCards: [{ id: "public-1", title: "Chapter 14", body: "A public chapter summary.", region: "Western Massachusetts", url: "https://example.org/chapter-14" }],
};

function english(children) {
  return <LanguageProvider lang="en">{children}</LanguageProvider>;
}

function spanish(children) {
  return <LanguageProvider lang="es">{children}</LanguageProvider>;
}

const WEEKLY_DRIVER = "Submit weekly question: question must be 10 to 280 characters";

const en = (key, vars) => translate("en", key, vars);
const es = (key, vars) => translate("es", key, vars);

async function submitRefusedWeeklyQuestion(wrapper, labels) {
  const submit = vi.fn().mockRejectedValue(new Error(WEEKLY_DRIVER));
  render(wrapper(<VoiceView weeklyQuestions={[]} onSubmitWeeklyQuestion={submit} />));
  fireEvent.change(screen.getByLabelText(labels.question), { target: { value: "Could we add another evening meeting?" } });
  fireEvent.change(screen.getByLabelText(labels.option1), { target: { value: "Tuesday" } });
  fireEvent.change(screen.getByLabelText(labels.option2), { target: { value: "Thursday" } });
  fireEvent.click(screen.getByRole("button", { name: labels.submit }));
  return screen.findByRole("alert");
}

describe("reward-backed member workflows", () => {
  it("renders no reward-backed public chapter cards on Home", () => {
    const { container } = render(english(<TodayView data={staleRewardToday} onPlanAction={vi.fn()} />));
    // Home itself still renders for the worker.
    expect(container.textContent).toContain("Alex");
    expect(screen.queryByRole("heading", { name: "Public chapter cards" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chapter 14" })).not.toBeInTheDocument();
    expect(screen.queryByText("A public chapter summary.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open public page" })).not.toBeInTheDocument();
    expect(container.querySelector('a[href="https://example.org/chapter-14"]')).toBeNull();
  });

  it("submits one bounded weekly question and supports another without exposing an author", async () => {
    const submit = vi.fn().mockResolvedValue({ id: "mine", created: true });
    const boost = vi.fn().mockResolvedValue({ created: true, weight: 2 });
    render(english(<VoiceView
      weeklyQuestions={[{ id: "q-1", body: "Can the chapter publish bargaining dates?", submittedByMe: false, boostedByMe: false, priority: true, score: 3 }]}
      onSubmitWeeklyQuestion={submit}
      onBoostWeeklyQuestion={boost}
    />));

    fireEvent.change(screen.getByLabelText("Your weekly question"), { target: { value: "Could we add another evening meeting?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Tuesday" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Thursday" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit question" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("Could we add another evening meeting?", ["Tuesday", "Thursday"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Support" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Support" }));
    await waitFor(() => expect(boost).toHaveBeenCalledWith("q-1"));
    expect(screen.queryByText("Alex Rivera")).not.toBeInTheDocument();
  });

  it("keeps Submit disabled until two poll options are filled, matching submit_weekly_poll_question", () => {
    const submit = vi.fn().mockResolvedValue({ id: "mine", created: true });
    render(english(<VoiceView weeklyQuestions={[]} onSubmitWeeklyQuestion={submit} />));
    fireEvent.change(screen.getByLabelText("Your weekly question"), { target: { value: "Could we add another evening meeting?" } });
    const button = screen.getByRole("button", { name: "Submit question" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Tuesday" } });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows a weekly-question refusal on the form", async () => {
    const alert = await submitRefusedWeeklyQuestion(english, {
      question: "Your weekly question",
      option1: "Option 1",
      option2: "Option 2",
      submit: "Submit question",
    });
    expect(alert).toHaveTextContent("The weekly question could not be submitted.");
    expect(alert.textContent).toBe("The weekly question could not be submitted.");
    expect(alert.textContent).not.toMatch(/question must be 10 to 280/);
    expect(alert.textContent).not.toMatch(/Submit weekly question/);
  });

  it("shows the Spanish weekly-question refusal on the form", async () => {
    const alert = await submitRefusedWeeklyQuestion(spanish, {
      question: "Tu pregunta semanal",
      option1: "Opción 1",
      option2: "Opción 2",
      submit: "Enviar pregunta",
    });
    expect(alert).toHaveTextContent("No se pudo enviar la pregunta semanal.");
    expect(alert.textContent).toBe("No se pudo enviar la pregunta semanal.");
    expect(alert.textContent).not.toMatch(/question must be 10 to 280/);
    expect(alert.textContent).not.toMatch(/Submit weekly question/);
    expect(alert.textContent).not.toMatch(/The weekly question could not be submitted/);
  });

  // The form alert is only half the screen: App.mutate raises its own toast for
  // the same rejection, and until the caller named its catalogue sentence that
  // toast carried the driver line the alert had just stopped showing.
  it("gives the weekly-question toast the catalogue sentence in both locales", () => {
    const refusal = new Error(WEEKLY_DRIVER);
    expect(mutationFailureNotice(en, refusal, "bevoice.weeklySubmitFailed")).toBe(
      "The weekly question could not be submitted.",
    );
    expect(mutationFailureNotice(es, refusal, "bevoice.weeklySubmitFailed")).toBe(
      "No se pudo enviar la pregunta semanal.",
    );
    expect(mutationFailureNotice(en, refusal, null)).toBe(en("toast.saveFailed"));
  });

  it("still prefers a tokenised refusal over the caller's catalogue sentence", () => {
    const tokenised = Object.assign(new Error("Scan check-in: code used"), { details: "scan_code_used" });
    expect(mutationFailureNotice(en, tokenised, "bevoice.weeklySubmitFailed")).toBe(
      "That code has already been used.",
    );
  });

  it("keeps the backed weekly workflow visible beside the SAMPLE member facade", () => {
    render(english(<VoiceView
      demo
      fixtureDemo={false}
      weeklyQuestions={[{
        id: "q-live",
        body: "Which safety topic should the campaign ask about?",
        submittedByMe: false,
        boostedByMe: false,
        priority: false,
        score: 2,
      }]}
      onSubmitWeeklyQuestion={vi.fn()}
      onBoostWeeklyQuestion={vi.fn()}
    />));

    expect(
      screen.getByRole("heading", { name: "Your feedback workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "What should the campaign ask this week?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Help choose the next poll" }),
    ).not.toBeInTheDocument();
  });
});

// Record 8435: Voice writes keep focus while they run, and a second activation
// in the same tick, before busy commits, sends nothing more.
describe("Voice writes while one runs", () => {
  const questions = [
    { id: "q-1", body: "Can the chapter publish bargaining dates?", submittedByMe: false, boostedByMe: false, priority: true, score: 3 },
    { id: "q-2", body: "Could stewards hold evening hours?", submittedByMe: true, boostedByMe: false, priority: false, promotionAvailable: true, score: 1 },
  ];
  const mount = (props, weekly = questions) => render(english(<VoiceView weeklyQuestions={weekly} {...props} />));
  const others = [questions[0]];
  const fillWeekly = () => {
    fireEvent.change(screen.getByLabelText("Your weekly question"), { target: { value: "Could we add another evening meeting?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Tuesday" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Thursday" } });
    return screen.getByRole("button", { name: "Submit question" });
  };

  it("keeps Submit question focused while it is sent, and submits once", async () => {
    const submit = vi.fn(async () => ({ id: "mine", created: true }));
    mount({ onSubmitWeeklyQuestion: submit, onBoostWeeklyQuestion: vi.fn() }, others);
    await expectHeldWriteFocus(submit, fillWeekly());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("starts one weekly write when Submit and Support are activated in one tick", async () => {
    const submit = vi.fn(async () => ({ id: "mine", created: true }));
    const boost = vi.fn(async () => ({ created: true }));
    const promote = vi.fn(async () => ({ promoted: true }));
    mount({ onSubmitWeeklyQuestion: submit, onBoostWeeklyQuestion: boost, onPromoteWeeklyQuestion: promote }, others);
    const send = fillWeekly();
    const support = screen.getByRole("button", { name: "Support" });
    await expectOneWriteFromOneTick([submit, boost], [() => fireEvent.click(send), () => fireEvent.click(send), () => fireEvent.click(support)]);
  });

  it("supports once when Support and Use promotion are activated in one tick", async () => {
    const boost = vi.fn(async () => ({ created: true }));
    const promote = vi.fn(async () => ({ promoted: true }));
    mount({ onSubmitWeeklyQuestion: vi.fn(), onBoostWeeklyQuestion: boost, onPromoteWeeklyQuestion: promote });
    const support = screen.getByRole("button", { name: "Support" });
    const promotion = screen.getByRole("button", { name: "Use promotion" });
    await expectOneWriteFromOneTick([boost, promote], [() => fireEvent.click(support), () => fireEvent.click(promotion), () => fireEvent.click(promotion)]);
  });

  it("keeps Support focused while the support is saved, and supports once", async () => {
    const boost = vi.fn(async () => ({ created: true }));
    mount({ onSubmitWeeklyQuestion: vi.fn(), onBoostWeeklyQuestion: boost });
    await expectHeldWriteFocus(boost, screen.getByRole("button", { name: "Support" }));
    expect(boost).toHaveBeenCalledExactlyOnceWith("q-1");
  });

  const fillSuggestion = () => {
    fireEvent.change(screen.getByLabelText("What's on your mind?"), { target: { value: "More evening meetings" } });
    return screen.getByRole("button", { name: "Send it" });
  };

  it("keeps Send it focused while the suggestion is handed to Compass, and sends once", async () => {
    const onSuggest = vi.fn(async () => undefined);
    mount({ onSuggest });
    await expectHeldWriteFocus(onSuggest, fillSuggestion());
    expect(onSuggest).toHaveBeenCalledTimes(1);
  });

  it("sends one suggestion when Send it is activated twice in one tick", async () => {
    const onSuggest = vi.fn(async () => undefined);
    mount({ onSuggest });
    const send = fillSuggestion();
    await expectOneWriteFromOneTick(onSuggest, [() => fireEvent.click(send), () => fireEvent.click(send)]);
  });
});

