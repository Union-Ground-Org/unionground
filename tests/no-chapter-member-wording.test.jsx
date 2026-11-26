// #9595 unit 3 (D2-2): with no chapter, Voting said "You vote in your
// chapter's ballots" and Rewards said rewards are granted by "your campaign
// admin", "a chapter admin grants every reward" and "live chapter values".
// A member row with no chapterId now reads the organization's wording; a
// member with a chapter, or one not loaded yet, keeps Main's.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { memberHasNoChapter } from "../src/lib/stewardConversations.js";
import { VotingView } from "../src/views/VotingView.jsx";
import { CasesView } from "../src/views/CasesView.jsx";

const NO_CHAPTER = { id: "m-1", initials: "IC", chapterId: "" };
const IN_CHAPTER = { id: "m-1", initials: "IC", chapterId: "c-1" };
const wrap = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);

const voting = (member, { lang, ...extra } = {}) => wrap(<VotingView data={{ planItems: [], ...(member ? { member } : {}) }} onPlanAction={vi.fn()} {...extra} />, lang);

// Grok read of #9682 (P2): the My cases empty state still said "your steward
// walks with you the whole way" with no steward named. no-chapter shows the
// setup line instead (App passes caseIntakeAvailable only with a chapter).
describe("My cases empty state with no steward named (#9595)", () => {
  const cases = (presence, lang, caseIntakeAvailable = presence !== "no-chapter") => wrap(<CasesView data={{ cases: [] }} stewardPresence={presence} caseIntakeAvailable={caseIntakeAvailable} onMessages={vi.fn()} />, lang);
  const EN = /a committee member walks with you the whole way/;
  const ES = /un miembro del comité te acompaña en todo el camino/;

  it.each(["none", "only-self", "no-chapter"])("drops the sentence in English and Spanish (%s)", (presence) => {
    let view = cases(presence, "en");
    expect(screen.queryByText(EN)).not.toBeInTheDocument();
    view.unmount();
    view = cases(presence, "es");
    expect(screen.queryByText(ES)).not.toBeInTheDocument();
    view.unmount();
  });

  it("says how filing works without promising a steward, in both languages", () => {
    const view = cases("none", "en");
    expect(screen.getByText("If something's wrong at work, filing takes 5 minutes. With no committee member named to review it yet, there is no set time for an answer.")).toBeInTheDocument();
    view.unmount();
    cases("only-self", "es");
    expect(screen.getByText(/no hay un plazo fijo de respuesta/)).toBeInTheDocument();
  });

  it.each(["named", "paused", "unknown"])("keeps Main's sentence when %s", (presence) => {
    let view = cases(presence, "en");
    expect(screen.getByText(EN)).toBeInTheDocument();
    view.unmount();
    view = cases(presence, "es");
    expect(screen.getByText(ES)).toBeInTheDocument();
    view.unmount();
  });
});

describe("memberHasNoChapter (#9595 D2-2)", () => {
  it("is true only for a loaded member with no chapter", () => {
    expect(memberHasNoChapter(NO_CHAPTER)).toBe(true);
    expect(memberHasNoChapter({ chapterId: null })).toBe(true);
    expect(memberHasNoChapter(IN_CHAPTER)).toBe(false);
    expect(memberHasNoChapter(null)).toBe(false);
    expect(memberHasNoChapter(undefined)).toBe(false);
  });
});

describe("Voting with no chapter (#9595 D2-2)", () => {
  it.each([[false], [true]])("does not speak of your campaign's ballots (desktop %s)", (desktop) => {
    voting(NO_CHAPTER, { desktop });
    expect(screen.queryByText(/your campaign's ballots/)).not.toBeInTheDocument();
    expect(screen.getByText("One worker, one vote. Ballots, both campaign and union-wide, open to you once you are in a campaign.")).toBeInTheDocument();
    // Review of 9cc66908: with no chapter the member reads no ballot at all
    // (private.current_member_organization() is found through the chapter),
    // so the rule must not say they vote in union-wide ballots.
    expect(screen.queryByText(/You vote in union-wide ballots/)).not.toBeInTheDocument();
  });

  it("does the same in the alternate layout and in Spanish", () => {
    voting(NO_CHAPTER, { alt: true, desktop: true, lang: "es" });
    expect(screen.queryByText(/boletas de tu campaña/)).not.toBeInTheDocument();
    expect(screen.getByText(/tanto de la campaña como de todo el sindicato, se abren para ti cuando estés en una campaña/)).toBeInTheDocument();
    expect(screen.queryByText(/Votas en las boletas de todo el sindicato/)).not.toBeInTheDocument();
  });

  it.each([["in a chapter", IN_CHAPTER], ["not loaded", undefined]])("keeps Main's rule when the member is %s", (_label, member) => {
    voting(member, { desktop: true });
    expect(screen.getByText("One worker, one vote. You vote in your campaign's ballots.")).toBeInTheDocument();
  });
});

