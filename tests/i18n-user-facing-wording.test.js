// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";

const actor = buildCoordinationActor({
  userId: "user-1", organizationId: "org-1", membershipStatus: "active",
  selectedHat: "coordinator", organizationRoles: ["coordinator"],
  mfaSatisfied: true, sessionScope: "resolved",
});
const mission = (id) => ({ id, kind: "mission", title: `Mission ${id}`, status: "active", visibility: "members" });
const model = (records) => ({
  state: "ready", organizationId: "org-1", staff: true, records,
  leaderboards: [], messages: [], resources: [], exportRuns: [], outreach: [],
});
function desk(lang, records) {
  return createElement(LanguageProvider, { lang },
    createElement(OrganizationCoordinationDesk, { actor, model: model(records), status: "ready" }));
}

describe("user-facing empty-state wording", () => {
  it("keeps implementation language out of English and Spanish catalogue values", () => {
    for (const lang of ["en", "es"]) {
      const values = Object.values(catalogue[lang]);
      expect(values.join("\n")).not.toMatch(/\b(?:seeded|seeding)\b|intentional empty workspace|(?:espacio vacío es intencional|contenido pre-cargado|sin cargar datos ficticios)/i);
      for (const key of ["clauses.sub", "clause.quickref.emptyCatalog", "coordination.emptyTabBody", "automation.pages.emptyWorkspace"]) {
        expect(catalogue[lang][key]).toMatch(lang === "es" ? /puede|Elige/ : /can|Choose/);
      }
    }
  });

  it.each([
    ["en", "1 record", "2 records"],
    ["es", "1 registro", "2 registros"],
  ])("renders singular and plural coordination counts in %s", (lang, one, two) => {
    const view = render(desk(lang, [mission("one")]));
    expect(screen.getByText(one)).toBeVisible();
    view.rerender(desk(lang, [mission("one"), mission("two")]));
    expect(screen.getByText(two)).toBeVisible();
  });

  it.each([
    ["en", "Mobilize", "Nothing in Mobilize yet"],
    ["es", "Movilizar", "Todavía no hay contenido en Movilizar"],
  ])("uses the %s tab's displayed name in its empty title", (lang, label, title) => {
    render(desk(lang, []));
    fireEvent.click(screen.getByRole("tab", { name: label }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { name: title })).toBeVisible();
    expect(panel).toHaveTextContent(label);
  });
});
