// The poll-suggestion audience control needs a name of its own
// (A11Y-UG-POLL-AUDIENCE-CONTROLS-DUPLICATE-INPUT-NAME-20260920).
//
// Both the phone card and the desktop rail pair a question text box with a
// radiogroup that chooses who the poll goes to. Both used to be labelled with
// the same string — "Suggest a poll question" on the phone, "Suggest a poll" on
// desktop — so a screen reader announced the audience chips under the text
// box's name and never said what the choice was for. The group now carries its
// own name; the text boxes keep theirs.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { VotingView } from "../src/views/VotingView.jsx";

function renderSuggest({ desktop = false, lang = "en" } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <VotingView data={fallbackData} demo desktop={desktop} onSuggestPoll={vi.fn()} onPlanAction={vi.fn()} />
    </LanguageProvider>,
  );
}

describe.each([
  ["phone", false],
  ["desktop", true],
])("poll audience control on %s", (_label, desktop) => {
  it("names the audience radiogroup separately from the question text box", () => {
    const view = renderSuggest({ desktop });
    const group = screen.getByRole("radiogroup");
    const input = view.container.querySelector(".voting-suggest__input");
    const groupName = group.getAttribute("aria-label");
    const inputName = input.getAttribute("aria-label");
    expect(groupName).toBeTruthy();
    expect(inputName).toBeTruthy();
    expect(groupName).not.toBe(inputName);
    expect(groupName).toBe(catalogue.en["voting.suggestAudience"]);
    view.unmount();
  });

  it("keeps both audience options inside the separately named group", () => {
    const view = renderSuggest({ desktop });
    const group = screen.getByRole("radiogroup");
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      catalogue.en["voting.myChapter"],
      catalogue.en["voting.wholeLocal"],
    ]);
    view.unmount();
  });

  it("translates the audience group name instead of reusing the Spanish text-box name", () => {
    const view = renderSuggest({ desktop, lang: "es" });
    const group = screen.getByRole("radiogroup");
    const input = view.container.querySelector(".voting-suggest__input");
    expect(group.getAttribute("aria-label")).toBe(catalogue.es["voting.suggestAudience"]);
    expect(group.getAttribute("aria-label")).not.toBe(input.getAttribute("aria-label"));
    view.unmount();
  });
});

describe("poll audience catalogue entry", () => {
  it("carries the audience name in every locale", () => {
    for (const [lang, entries] of Object.entries(catalogue)) {
      expect(entries["voting.suggestAudience"], `missing voting.suggestAudience for ${lang}`).toBeTruthy();
    }
  });
});
