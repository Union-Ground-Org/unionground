import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CasesView } from "../src/views/CasesView.jsx";

// BUG-UG-NO-CHAPTER-PAGES-GO-BLANK-OR-BLAME-PERMISSIONS-20261122
// (#9594, D2-4): a member of an organization with no chapter yet opened My
// cases and read "Chapter setup required. Your campaign needs to be connected
// before you can start a case.", with no word on who connects it. It now
// says the member is not in a chapter yet, that a case is handled in a
// chapter, and that an administrator of the organization sets chapters
// up and adds members. No link: the page that adds a chapter refuses a reader
// with no chapter on a live backend (get_admin_org_structure).

afterEach(cleanup);

function renderCases({ lang = "en", chapter = false, desktop = false } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <CasesView
        data={{ member: { id: "member-1", chapterId: chapter ? "ch-1" : null }, cases: [] }}
        caseIntakeAvailable={chapter}
        desktop={desktop}
        onCreateCase={vi.fn()}
      />
    </LanguageProvider>,
  );
}

describe("My cases for a member in no chapter yet (#9594 D2-4)", () => {
  it("says the member is in no chapter and who sets chapters up, on the phone and desktop layouts", () => {
    for (const desktop of [false, true]) {
      const { unmount } = renderCases({ desktop });
      expect(screen.getByRole("heading", { name: "You are not in a campaign yet" })).toBeInTheDocument();
      expect(screen.getByText("An issue is handled in your campaign. An administrator of your organization sets up its campaigns and adds workers to them. Once you are in a campaign, you can start an issue here.")).toBeInTheDocument();
      expect(screen.queryByText(/Chapter setup required/)).not.toBeInTheDocument();
      expect(screen.queryByText(/needs to be connected/)).not.toBeInTheDocument();
      // Intake stays closed: no way to start a case that has nowhere to go.
      expect(screen.queryByRole("button", { name: /Start a( new)? case|\+ New/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("says the same in Spanish", () => {
    renderCases({ lang: "es" });
    expect(screen.getByRole("heading", { name: "Todavía no estás en una campaña" })).toBeInTheDocument();
    expect(screen.getByText(t("es", "mcases.setupBody"))).toBeInTheDocument();
    expect(t("es", "mcases.setupBody")).toMatch(/administrador de tu organización/);
    expect(t("es", "mcases.setupBody")).not.toBe(t("en", "mcases.setupBody"));
  });

  it("leaves a member who is in a chapter on the usual empty state with Start an issue", () => {
    renderCases({ chapter: true });
    expect(screen.getByRole("heading", { name: t("en", "mcases.emptyTitle") })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "You are not in a campaign yet" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("en", "mcases.startCase") })).toBeInTheDocument();
  });
});
