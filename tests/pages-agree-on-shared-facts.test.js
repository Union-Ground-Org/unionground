// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533):
// two pages stated one fact differently and no label said why. The rendered
// checks live beside each screen's own tests (home-voice-open-items, rewards-
// view, mfa-followups, member-support-view, learning-content-web); these read
// the shared catalogue lines that carried the contradiction, in both languages.
import { describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";

const LANGS = ["en", "es"];

describe("#9533 A-19: one verification status across Admin pages", () => {
  // Chapter partnerships printed "<organization> · Verified" for the chapter's
  // link to a catalog listing, while Organization verification said the
  // organization itself was self-reported. The line now names the link.
  it.each(LANGS)("labels the chapter binding's status as the link's, not the organization's (%s)", (lang) => {
    const line = t(lang, "admin.chapterLifecycle.bindingState", {
      organization: "Tamarack Valley HSU",
      status: t(lang, "admin.chapterLifecycle.status.verified"),
    });
    expect(line).toMatch(lang === "en" ? /^Tamarack Valley HSU · Link to this campaign: Verified$/ : /^Tamarack Valley HSU · Vínculo con esta campaña: Verificad/);
  });

  // Vouch for chapters told every admin "As a verified organization you can
  // vouch", whatever Organization verification showed.
  it.each(LANGS)("does not tell an unverified organization it is verified on Vouch for chapters (%s)", (lang) => {
    const intro = t(lang, "unions.vouch.intro");
    expect(intro).not.toMatch(/^As a verified organization|^Como organización verificada/);
    expect(intro).toMatch(lang === "en" ? /^Once your organization is verified/ : /^Cuando tu organización esté verificada/);
  });
});

describe("#9533 B-20: Pulse states one privacy floor", () => {
  // The subtitle said "the floor of ten" while the cards below printed the
  // configured floor (25). The floor is only ever printed from the server's value.
  it.each(LANGS)("keeps the number out of the subtitle and prints the floor from data (%s)", (lang) => {
    expect(t(lang, "pulse.sub")).not.toMatch(/\d|\bten\b|\bdiez\b/i);
    expect(t(lang, "pulse.floor", { floor: 25 })).toContain("25");
    expect(t(lang, "pulse.withheld", { floor: 25 })).toContain("25");
  });

  // "Your charts" (server-saved) said none while My reports showed a custom
  // chart; that chart lives only in this browser, and its card now says so.
  it.each(LANGS)("says a My reports custom chart is kept in this browser (%s)", (lang) => {
    expect(t(lang, "reports.customSub")).toMatch(lang === "en" ? /this browser/ : /este navegador/);
  });
});
