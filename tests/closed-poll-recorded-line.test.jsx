import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VotingView } from "../src/views/VotingView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { closedPollRecordedLine, pollRecordedCopy } from "../src/lib/pollRecordedCopy.js";

// BUG-UG-CLOSED-POLL-PROMISES-RESULTS-20261106: Voting never shows
// pulse results, yet an answered poll that closed in 2025 still said "chapter
// results share after close". A closed poll now says the answer was recorded
// and the poll has closed; nothing about results is promised or invented.
afterEach(cleanup);

const pulse = (id, closed) => ({
  id,
  kind: "pulse",
  title: `Poll ${id}`,
  body: "",
  meta: closed ? "2-min pulse · Closes Mar 6, 2025 · Closed" : "2-min pulse · Closes Dec 1, 2026",
  closed,
  selectedOption: `${id}-yes`,
  options: [{ id: `${id}-yes`, label: "Yes" }, { id: `${id}-no`, label: "No" }],
});

function renderVoting(lang) {
  const data = { ...fallbackData, planItems: [pulse("open", false), pulse("closed", true)] };
  return render(<LanguageProvider lang={lang}><VotingView data={data} desktop /></LanguageProvider>);
}

describe("answered poll line", () => {
  it.each(["en", "es"])("keeps the results line on an open poll and drops the promise on a closed one (%s)", (lang) => {
    renderVoting(lang);
    const open = catalogue[lang]["voting.pulseRecorded"].replace("{label}", "Yes");
    const closed = closedPollRecordedLine(lang, "Yes");
    expect(screen.getAllByText(open)).toHaveLength(1);
    expect(screen.getAllByText(closed)).toHaveLength(1);
  });

  it("words the closed line without any results promise, outside the locale barrels", () => {
    expect(pollRecordedCopy.en.closed).toBe("\"{label}\" recorded · this poll has closed.");
    expect(pollRecordedCopy.es.closed).toBe("\"{label}\" registrado · esta encuesta ya cerró.");
    for (const lang of ["en", "es"]) expect(pollRecordedCopy[lang].closed).not.toMatch(/result|resultado/i);
    expect(closedPollRecordedLine("fr", "Yes")).toBe("\"Yes\" recorded · this poll has closed.");
    expect(closedPollRecordedLine("en", undefined)).toBe("\"\" recorded · this poll has closed.");
    expect(catalogue.en["voting.pulseRecordedClosed"]).toBeUndefined();
  });
});
