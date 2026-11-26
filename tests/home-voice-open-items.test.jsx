import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../src/views/TodayView.jsx";
import { VotingView } from "../src/views/VotingView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";

const survey = { id: "pulse-count", kind: "pulse", title: "Workplace priorities", closed: false,
  meta: "Closes Friday", action: "Answer", options: [{ id: "safety", label: "Safety" }] };
const ballot = { ...survey, id: "ballot-count", kind: "ballot", title: "Contract vote", action: "Vote" };
const data = (planItems) => ({ ...fallbackData, planItems });
const wrap = (child, lang = "en") => <LanguageProvider lang={lang}>{child}</LanguageProvider>;
afterEach(() => clearDeviceParityState());

describe("Home and Voice open vote/survey agreement", () => {
  it("labels the Home survey fallback and action as a survey, and opens that exact survey", () => {
    const onPlanAction = vi.fn();
    render(wrap(<TodayView data={data([survey])} onPlanAction={onPlanAction} />));
    const card = screen.getByRole("article", { name: survey.title });
    expect(within(card).getByText("Open survey")).toBeInTheDocument();
    expect(within(card).queryByText(/vote/i)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Submit answer" }));
    expect(onPlanAction).toHaveBeenCalledWith(survey);
  });

  it.each([false, true])("shows the same distinct counts in Home and Voice (desktop=%s)", (desktop) => {
    // Completion does not close the window for other members. Closed items and lessons never count.
    const snapshot = data([ballot, { ...ballot, id: "voted", receiptCode: "RECEIPT" }, survey,
      { ...survey, id: "answered", selectedOption: "safety" }, { ...survey, id: "closed-survey", closed: true },
      { ...ballot, id: "closed-vote", closed: true }, { id: "lesson", kind: "lesson", closed: false }]);
    const home = render(wrap(<TodayView data={snapshot} desktop={desktop} onPlanAction={vi.fn()} />));
    expect(screen.getByText("2 open votes · 2 open surveys")).toBeInTheDocument();
    home.unmount();
    render(wrap(<VotingView data={snapshot} desktop={desktop} onPlanAction={vi.fn()} />));
    expect(screen.getByText("2 open votes · 2 open surveys")).toBeInTheDocument();
  });

  // An organization survey is answered in Voice
  // ("Be heard"), so Voting does not count one it never lists. Home names it
  // as its own part of the line, so the "open surveys" figure is the same on
  // both screens (#9533 B-4: Home said 8 open surveys, Voting 6).
  it.each(["en", "es"])("states the same open-survey count on Home and Voting and names organization surveys apart (%s)", (lang) => {
    const closesAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const snapshot = { ...data([ballot, survey]), organizationSurveys: [
      { id: "org-survey", title: "Staffing check-in", closesAt, answered: false },
      { id: "org-survey-2", title: "Parking check-in", closesAt, answered: false },
    ] };
    const surveysPart = (text) => text.split(" · ")[1];
    const home = render(wrap(<TodayView data={snapshot} desktop onPlanAction={vi.fn()} />, lang));
    const homeLine = lang === "en"
      ? "1 open vote · 1 open survey · 2 organization surveys in Be heard"
      : "1 votación abierta · 1 encuesta abierta · 2 encuestas de la organización en Hazte oír";
    expect(screen.getByText(homeLine)).toBeInTheDocument();
    home.unmount();
    render(wrap(<VotingView data={snapshot} desktop onPlanAction={vi.fn()} />, lang));
    const votingLine = lang === "en" ? "1 open vote · 1 open survey" : "1 votación abierta · 1 encuesta abierta";
    expect(screen.getAllByText(votingLine).length).toBeGreaterThan(0);
    expect(surveysPart(homeLine)).toBe(surveysPart(votingLine));
  });

  // #9533 gate read: one fixture with an answered survey, a closed one and
  // organization-only ones (one answered, one past its close) on both screens.

  it.each(["en", "es"])("does not label a survey-only window as all closed (%s)", (lang) => {
    render(wrap(<VotingView data={data([survey])} desktop onPlanAction={vi.fn()} />, lang));
    expect(screen.getByText(lang === "en" ? "0 open votes · 1 open survey" : "0 votaciones abiertas · 1 encuesta abierta")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: lang === "en" ? "No open votes" : "No hay votos abiertos" })).toBeInTheDocument();
  });
});
