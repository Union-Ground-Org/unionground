// BUG-UG-SITE-GUIDE-SEARCH-HINT-SUGGESTS-STAFF-TERMS-TO-MEMBERS-20261103
// (#6858): the Site guide search box suggested "roster, invitations or dues" to
// every reader, but a member's guide has no section for roster or invitations.
// The hint now names only words that find a section this reader can see, and a
// member's search for a staff topic says it belongs to a staff role.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import {
  buildSiteGuide,
  filterSiteGuideSections,
  siteGuideSearchWords,
  siteGuideStaffOnlyDesks,
} from "../src/lib/siteGuide.js";
import { SiteGuideView } from "../src/views/SiteGuideView.jsx";

const en = (key, vars) => translate("en", key, vars);
const es = (key, vars) => translate("es", key, vars);
const labelOf = (t) => (item) => t(item.labelKey);

function renderGuide(props = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><SiteGuideView onNavigate={vi.fn()} {...props} /></LanguageProvider>);
}

describe("site guide search hint words", () => {
  for (const [lang, t] of [["en", en], ["es", es]]) {
    for (const roles of [[], ["admin"], ["steward"], ["coordinator"], ["advisor"], ["vp"]]) {
      it(`every suggested word finds a section the reader can see (${lang}, roles ${roles.join(",") || "member"})`, () => {
        const { sections } = buildSiteGuide({ t, roles });
        const words = siteGuideSearchWords(sections, t, labelOf(t));
        expect(words).toHaveLength(roles.length ? 3 : 2);
        for (const word of words) expect(filterSiteGuideSections(sections, word, labelOf(t)).length, word).toBeGreaterThan(0);
      });
    }
  }

  it("suggests member words to a member and desk words first to an admin", () => {
    expect(siteGuideSearchWords(buildSiteGuide({ t: en, roles: [] }).sections, en, labelOf(en))).toEqual(["voting", "notifications"]);
    expect(siteGuideSearchWords(buildSiteGuide({ t: en, roles: ["admin"] }).sections, en, labelOf(en))).toEqual(["invitations", "voting", "notifications"]);
  });

  it("drops a word that no longer finds anything, such as after an organization rewrote the section", () => {
    const sections = [
      { key: "me", label: "Mine", body: "Your own work.", steps: [], destinations: [] },
      { key: "union", label: "Union", body: "Pay and dues.", steps: [], destinations: [] },
    ];
    expect(siteGuideSearchWords(sections, en)).toEqual(["dues"]);
  });

  // Merged root coverage on #6883: without a label reader, page links match by
  // their label key, so a key-named word still counts.
  it("matches page links by label key when no label reader is passed", () => {
    const sections = [{ key: "me", label: "Mine", body: "", steps: [], destinations: [{ key: "v", labelKey: "voting" }] }];
    expect(siteGuideSearchWords(sections, en)).toEqual(["voting"]);
  });
});

describe("site guide search for a staff topic", () => {
  it("names the staff desks a member's search would find, and none for a desk the reader holds", () => {
    expect(siteGuideStaffOnlyDesks({ t: en, roles: [], query: "invitations", labelOf: labelOf(en) })).toEqual([en("demo.hatAdmin")]);
    expect(siteGuideStaffOnlyDesks({ t: en, roles: ["admin"], query: "invitations", labelOf: labelOf(en) })).toEqual([]);
    expect(siteGuideStaffOnlyDesks({ t: en, roles: [], query: "qqqqq", labelOf: labelOf(en) })).toEqual([]);
  });

  // Merged root coverage on #6883: the defaults read as a plain member with no
  // organization copy, and page links match by their label key.
  it("treats a call with only a query as a plain member and matches page links by label key", () => {
    expect(siteGuideStaffOnlyDesks({ t: en, query: "admin.rolesTitle" })).toEqual([en("demo.hatAdmin")]);
  });
});

describe("site guide search page", () => {
  it("shows a member the member hint and says a staff topic belongs to a staff role", () => {
    renderGuide({ roles: [] });
    const search = screen.getByRole("searchbox", { name: "Search the guide" });
    expect(search).toHaveAttribute("placeholder", "Try voting or notifications");
    expect(search.getAttribute("placeholder")).not.toMatch(/roster|invitations/);
    fireEvent.change(search, { target: { value: "invite" } });
    expect(screen.getByText(en("siteGuide.searchStaffOnly", { query: "invite", roles: "Admin or Campaign chair" }))).toBeInTheDocument();
    expect(screen.queryByText(en("siteGuide.searchEmpty", { query: "invite" }))).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "qqqqq" } });
    expect(screen.getByText(en("siteGuide.searchEmpty", { query: "qqqqq" }))).toBeInTheDocument();
  });

  it("shows an admin the desk hint, finds invitations, and keeps the plain empty message for unknown words", () => {
    renderGuide({ roles: ["admin"] });
    const search = screen.getByRole("searchbox", { name: "Search the guide" });
    expect(search).toHaveAttribute("placeholder", "Try invitations, voting, or notifications");
    fireEvent.change(search, { target: { value: "invitations" } });
    expect(screen.getByRole("heading", { level: 2, name: en("demo.hatAdmin") })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "qqqqq" } });
    expect(screen.getByText(en("siteGuide.searchEmpty", { query: "qqqqq" }))).toBeInTheDocument();
  });

  it("builds the hint in Spanish from the Spanish words", () => {
    renderGuide({ roles: [] }, "es");
    expect(screen.getByRole("searchbox", { name: "Buscar en la guía" })).toHaveAttribute("placeholder", "Prueba votaciones o notificaciones");
  });
});
