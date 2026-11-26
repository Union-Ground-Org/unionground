// @vitest-environment jsdom
// BUG-UG-CASE-PRIVACY-COPY-MISSTATES-READERS-20261106 (#7194). A staff
// case note is stored on the member's own member_case_updates row, so the
// member reads it word for word; case documents open to the member's steward
// and, by default, every steward in the chapter's grievance scope. The copy
// must name those readers and never call a case note private.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseNoteComposer } from "../src/components/CaseMentions.jsx";
import { StewardCaseNoteForm } from "../src/features/caseNotes/StewardCaseNotes.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

afterEach(cleanup);

const en = catalogue.en;
const es = catalogue.es;
const t = (key, vars = {}) => en[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

describe("case note composers say who reads the note", () => {
  it("never calls a case note private in English or Spanish", () => {
    for (const key of ["caseNotes.staffNoteLabel", "caseNotes.memberNotePlaceholder"]) {
      expect(en[key]).not.toMatch(/private/i);
      expect(es[key]).not.toMatch(/privad[ao]/i);
    }
    expect(en["caseNotes.staffNoteLabel"]).toBe("Issue note");
    expect(es["caseNotes.staffNoteLabel"]).toBe("Nota del asunto");
  });

  it("names the member and case staff as readers and points staff-only notes to private reminders", () => {
    expect(en["caseNotes.noteAudience"]).toBe("The worker and the staff on this issue can read this note. Keep anything only you should see in My private reminders.");
    expect(es["caseNotes.noteAudience"]).toBe("El trabajador y el personal de este asunto pueden leer esta nota. Guarda lo que solo tú debes ver en Mis recordatorios privados.");
    expect(en["caseNotes.noteAudience"]).toContain(en["caseworkDeadlines.private.title"]);
    expect(es["caseNotes.noteAudience"]).toContain(es["caseworkDeadlines.private.title"]);
  });

  it("shows the readers under the coordinator composer", () => {
    render(<CaseNoteComposer caseId="case-a" candidates={[]} onSubmit={vi.fn()} t={t} />);
    expect(screen.getByLabelText("Issue note")).toBeInTheDocument();
    expect(screen.getByText(en["caseNotes.noteAudience"])).toBeVisible();
  });

  it("shows the readers under the steward composer in Spanish", () => {
    wrap(<StewardCaseNoteForm caseId="case-a" onAdd={vi.fn()} />, "es");
    expect(screen.getByText(es["caseNotes.noteAudience"])).toBeVisible();
  });

});

describe("case document help names the real audience", () => {
  it("tells the member that their steward and the chapter's stewards can open documents unless the case is restricted", () => {
    expect(en["caseNotes.memberDocumentsHelp"]).toMatch(/^You, your committee member, your campaign's committee members and campaign leads can open these documents\. A campaign lead can restrict the issue to fewer people\./);
    expect(es["caseNotes.memberDocumentsHelp"]).toMatch(/^Tú, tu miembro del comité, los miembros del comité de tu campaña y los líderes de campaña de asuntos pueden abrir estos documentos\. Un líder de campaña de asuntos puede restringir el asunto a menos personas\./);
    expect(en["caseNotes.memberDocumentsHelp"]).not.toMatch(/private/i);
    expect(es["caseNotes.memberDocumentsHelp"]).not.toMatch(/privad[ao]s?/i);
  });

  it("gives the coordinator screen the same audience in third person", () => {
    expect(en["caseNotes.staffDocumentsHelp"]).toMatch(/^The worker, their committee member, the campaign's committee members and campaign leads can open these documents unless a campaign lead restricts the issue\./);
    expect(es["caseNotes.staffDocumentsHelp"]).toMatch(/^El trabajador, su miembro del comité, los miembros del comité de la campaña y los líderes de campaña de asuntos pueden abrir estos documentos, salvo que un líder de campaña restrinja el asunto\./);
  });
});

// The legacy keys (coordinator.noteBody "Private case note", cases.documentsHelp,
// cases.addNotePlaceholder) stay in src/lib/i18n.js and es.js until those files
// can change outside a legal release in the mobile lane; no screen may read them.
describe("no case screen reads the old private wording", () => {
  // The alternate case desk's field note is left out of this edition.
  it.each([
    "src/components/CaseMentions.jsx", "src/components/CaseMacroEditor.jsx", "src/components/CaseBulkActions.jsx",
    "src/views/CoordinatorView.jsx", "src/views/CasesView.jsx", "src/features/caseNotes/StewardCaseNotes.jsx",
  ])("%s uses the corrected keys", (path) => {
    expect(readFileSync(path, "utf8")).not.toMatch(/"(?:coordinator\.noteBody|cases\.documentsHelp|cases\.addNotePlaceholder)"/);
  });
});
