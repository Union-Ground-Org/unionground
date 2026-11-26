import { describe, expect, it } from "vitest";
import { leadershipRoleLine } from "../src/lib/chapterLeadership.js";
import { t } from "../src/lib/i18n.js";

describe("campaign lead access wording (#7662 option b)", () => {
  // This edition's role names win (integrator ruling, Nov 25, 2026):
  // coordinator = "Campaign lead", vp = "Campaign chair". Upstream's cases that
  // named chapter access "Chapter lead" / "President" collide with them and are
  // cut: the neutral chapter-access name, the organization-wide vp wording, the
  // two-step notices' scope names and the chapter-scoped help wording.

  it.each(["Vice President", "Chair", "Chief Steward", "President"])("uses the person's display title %s, rather than inferring one from vp", (title) => {
    expect(leadershipRoleLine({ title, president: true }, (key) => t("en", key))).toBe(title);
  });

  it.each([["en", "Chapter lead"], ["es", "Líder de la campaña"]])("uses the neutral fallback only when no display title is set (%s)", (lang, label) => {
    for (const title of [null, undefined, "  ", 42]) {
      expect(leadershipRoleLine({ title, president: true }, (key) => t(lang, key))).toBe(label);
    }
    expect(leadershipRoleLine(null, (key) => t(lang, key))).toBe("");
  });

  it.each([["en", "Campaign lead or organization Campaign chair"], ["es", "Líder de la campaña o Presidencia de la organización"]])("explains a shared or unsplit vp access category in %s", (lang, label) => {
    expect(t(lang, "admin.roleVpAccess")).toBe(label);
  });
});
