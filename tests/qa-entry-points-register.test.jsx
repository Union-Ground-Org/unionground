import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { USTED_MARKERS as QA_ENTRY_USTED_MARKERS } from "./i18nRegisterMarkers.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { VoiceView } from "../src/views/VoiceView.jsx";

// UX-UG-QA-ENTRY-POINTS-STILL-USTED-20260917
//
// The Q&A chrome (PR #2124) reads in tú. The live door into it still spoke
// usted on Main: bevoice.qaBody on Be Heard. morehub.qa / morehub.qaMeta were
// a second door that never mounted (UX-UG-MOREHUB-QA-ROW-DEAD-KEYS-20260917)
// and are deleted rather than wired. This file owns the register guard so it
// does not append to tests/i18n-coverage.test.jsx (PRs #2116, #2122, #2123,
// #2124, #2125 and the parallel features-copy lane each append their own
// describe there).
//
// Two properties this guard has to keep, both mutation-proved in review:
//
// 1. Boundaries are letter-class, not `\b`. `\b` is ASCII-only: `\bdé\b` can
//    never match, because `é` is a non-word character to it, and `\ble\b`
//    false-positives inside `leí`. The marker list therefore carries at least
//    one accented imperative (`dé`) so the boundary is load-bearing and not
//    decorative — see the boundary self-test below.
// 2. Rendered text is read node by node, never as one `textContent` blob.
//    `textContent` concatenates sibling elements with no separator, so the
//    More hub row "Preguntas de afiliados" + "pregunte al capítulo" reads as
//    "…afiliadospregunte…" and the leading `pregunte` loses its left boundary.
//    A `textContent` scan silently missed exactly that regression.

const MAIN_ES_QA_ENTRY = Object.freeze({
  "bevoice.qaBody": "Pregunte a su capítulo. Las respuestas oficiales las publica un delegado o oficial.",
  "morehub.qaMeta": "pregunte al capítulo",
});

const MAIN_EN_QA_ENTRY = Object.freeze({
  "bevoice.qaBody": "Ask your campaign. Official replies come from a committee member or campaign lead.",
  "morehub.qaMeta": "ask the chapter",
});

// Formal imperatives and usted pronouns come from tests/i18nRegisterMarkers.js.
// `dé` stays in that list so the letter-class boundary below is load-bearing.

function spanish(children) {
  return <LanguageProvider lang="es">{children}</LanguageProvider>;
}

// Every text node on its own line: sibling elements must not be concatenated
// into a word that never appears on screen, in either direction.
function renderedLines(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines = [];
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue.trim();
    if (text) lines.push(text);
    node = walker.nextNode();
  }
  return lines.join("\n");
}

afterEach(() => {
  cleanup();
});

describe("QA entry points speak tú", () => {
  it("uses letter-class boundaries that `\\b` cannot provide", () => {
    // The accented imperative is reachable here and unreachable with `\b`.
    expect("Dé los hechos").toMatch(QA_ENTRY_USTED_MARKERS);
    expect(/\bdé\b/i.test("Dé los hechos")).toBe(false);
    // And the boundary does not fire inside a longer word, where `\b` would.
    expect("Leí el contrato").not.toMatch(QA_ENTRY_USTED_MARKERS);
    expect(/\ble\b/i.test("Leí el contrato")).toBe(true);
    expect("Lo que envíes por Compass").not.toMatch(QA_ENTRY_USTED_MARKERS);
  });

  it("fails on Main's usted copy and stays green on the tú replacements", () => {
    expect(MAIN_ES_QA_ENTRY["bevoice.qaBody"]).toMatch(QA_ENTRY_USTED_MARKERS);
    // Frozen Main copy of the never-mounted More-hub meta: the marker list
    // still has to catch `pregunte` so a later wiring cannot sneak usted back.
    expect(MAIN_ES_QA_ENTRY["morehub.qaMeta"]).toMatch(QA_ENTRY_USTED_MARKERS);

    // EN must not move a byte: the record changes register on the ES side only.
    expect(catalogue.en["bevoice.qaBody"]).toBe(MAIN_EN_QA_ENTRY["bevoice.qaBody"]);

    expect(catalogue.es["bevoice.qaBody"]).toBe("Pregunta a tu campaña. Las respuestas oficiales las publica un miembro del comité o el liderazgo de campaña.");
    expect(catalogue.es["bevoice.qaBody"]).not.toMatch(QA_ENTRY_USTED_MARKERS);
    expect(catalogue.es["bevoice.qaBody"]).toMatch(/\btu\b/);
  });

  it("renders Be Heard in Spanish with no usted marker on the Q&A door", () => {
    render(spanish(
      <VoiceView onOpenQa={vi.fn()} onMessageSteward={vi.fn()} threads={[]} />,
    ));

    const qa = document.querySelector("[data-mi1-surface='voice-qa']");
    expect(qa, "Be Heard Q&A teaser did not mount").toBeTruthy();
    expect(within(qa).getByText(catalogue.es["bevoice.qaBody"])).toBeInTheDocument();
    expect(within(qa).getByRole("heading", { name: catalogue.es["bevoice.qaTitle"] })).toBeInTheDocument();
    expect(renderedLines(qa)).not.toMatch(QA_ENTRY_USTED_MARKERS);

    const screenRoot = document.querySelector(".bevoice-screen");
    expect(screenRoot, "Be Heard screen did not mount").toBeTruthy();
    expect(renderedLines(screenRoot)).not.toMatch(QA_ENTRY_USTED_MARKERS);
  });

  // The More hub has no Q&A row. `morehub.qa` / `morehub.qaMeta` were added
  // with the CR-018 Q&A wiring (c0e8a9bc5) and never mounted — phone All
  // features still reaches Q&A through nav.qa. Option (b) of
  // UX-UG-MOREHUB-QA-ROW-DEAD-KEYS-20260917 deletes the pair so they
  // cannot return unreferenced. A later wiring must add keys, mount a HubRow,
  // and replace this absence scan with renderedLines() of the live row.
  it("renders the live More hub in Spanish without a Q&A row", () => {
    render(spanish(
      <SettingsView
        data={{ member: { initials: "MV" }, roles: [] }}
        lang="es"
        onLanguage={vi.fn()}
        onSignOut={vi.fn()}
      />,
    ));

    expect(screen.getByRole("heading", { level: 1, name: catalogue.es["nav.settings"] })).toBeInTheDocument();
    expect(screen.getByText(catalogue.es["morehub.beHeard"])).toBeInTheDocument();

    const hub = renderedLines(document.body);
    expect(hub).toContain(catalogue.es["morehub.beHeardMeta"]);
    expect(hub).not.toContain(MAIN_ES_QA_ENTRY["morehub.qaMeta"]);
    expect(screen.queryByText("Preguntas de afiliados")).toBeNull();
    expect(screen.queryByText(MAIN_EN_QA_ENTRY["morehub.qaMeta"])).toBeNull();
  });

  it("does not keep dead morehub.qa* catalogue keys", () => {
    const enDead = Object.keys(catalogue.en).filter((key) => key.startsWith("morehub.qa"));
    const esDead = Object.keys(catalogue.es).filter((key) => key.startsWith("morehub.qa"));
    expect(enDead).toEqual([]);
    expect(esDead).toEqual([]);
  });
});
