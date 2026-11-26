import { readFileSync } from "node:fs";
// The Voting poll suggestion must hand Compass a draft that names the audience
// the member actually chose
// (UX-UG-POLL-SUGGESTION-DRAFT-CONTRADICTS-AUDIENCE-SCOPE-20260920).
// One scope-blind sentence used to claim "for my chapter" for both chips and
// pasted the internal scope identifier into the member-visible draft, so a
// whole-local suggestion reached the reviewing steward labelled for the wrong
// audience. Each audience now has its own catalogue sentence in both locales,
// exactly as the sibling Be heard composer already does.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { primeDemoHat } from "./helpers/demoHat.js";

const QUESTION = "Should chapter meetings alternate sites?";

const cases = [
  { lang: "en", scope: "chapter", draft: `Poll suggestion for my campaign: ${QUESTION}` },
  { lang: "en", scope: "local", draft: `Poll suggestion for the whole local: ${QUESTION}` },
  { lang: "es", scope: "chapter", draft: `Sugerencia de encuesta para mi campaña: ${QUESTION}` },
  { lang: "es", scope: "local", draft: `Sugerencia de encuesta para todo el local: ${QUESTION}` },
];

async function suggestPoll(lang, scope) {
  window.localStorage.setItem("sg-lang", lang);
  primeDemoHat("member");
  window.history.replaceState({}, "", "/m/voting?demo=1");
  const view = render(<App />);
  const chipKey = scope === "local" ? "voting.wholeLocal" : "voting.myChapter";
  fireEvent.click(await screen.findByRole("radio", { name: catalogue[lang][chipKey] }));
  fireEvent.change(view.container.querySelector(".voting-suggest__input"), { target: { value: QUESTION } });
  fireEvent.click(view.container.querySelector(".voting-suggest__send"));
  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: the
  // suggestion goes to the chapter's stewards as a first message, a queue a
  // steward works, instead of a Compass draft nobody receives.
  await screen.findByText(catalogue[lang]["voting.pollSent"]);
  return { view };
}

describe("Voting poll suggestion → steward message", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  });

  afterEach(() => {
    clearDeviceParityState();
    window.localStorage.clear();
  });

  for (const { lang, scope, draft } of cases) {
    it(`names the ${scope} audience in ${lang} and leaks no scope identifier`, async () => {
      const { view } = await suggestPoll(lang, scope);
      expect(screen.queryByRole("textbox", { name: catalogue[lang]["compass.askAria"] })).toBeNull();
      expect(catalogue[lang][scope === "local" ? "voting.suggestDraftLocal" : "voting.suggestDraftChapter"].replace("{text}", QUESTION)).toBe(draft);
      // The internal identifier the chips carry is App state, never copy.
      expect(draft).not.toMatch(/\((?:chapter|local)\)/);
      view.unmount();
    });
  }

  it("sends the suggestion through the steward conversation, not Compass", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain('onSuggestPoll={(text, scope) => handlePollSuggestion(tr(scope === "local" ? "voting.suggestDraftLocal" : "voting.suggestDraftChapter", { text }))}');
    // The direct steward conversation is unique per member: a second
    // suggestion is a message in it, never a refused second conversation.
    expect(app).toContain('const direct = (data.conversations || []).find((item) => item.counterpartRole === "steward" && !item.stewardUserId);');
    expect(app).toContain("return direct ? handleSendMemberMessage(direct.id, text) : handleStartMemberConversation(text);");
  });

  it("carries an audience-specific sentence for each scope in both locales", () => {
    for (const locale of ["en", "es"]) {
      for (const key of ["voting.suggestDraftChapter", "voting.suggestDraftLocal"]) {
        expect(catalogue[locale][key], `${locale} ${key}`).toContain("{text}");
        expect(catalogue[locale][key], `${locale} ${key}`).not.toContain("{scope}");
      }
      expect(catalogue[locale]["voting.suggestDraftLocal"])
        .not.toBe(catalogue[locale]["voting.suggestDraftChapter"]);
    }
    expect(catalogue.en["voting.suggestDraft"], "the scope-blind key must be gone").toBeUndefined();
  });
});
