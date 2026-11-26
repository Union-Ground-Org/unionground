import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FormsView } from "../src/views/FormsView.jsx";

// BUG-UG-NO-CHAPTER-PAGES-GO-BLANK-OR-BLAME-PERMISSIONS-20261122
// (#9594, D2-4): with no chapter, My cases blocked a new case while Forms let
// the same member start a three-step grievance report that no steward could
// see (save_member_form_draft and submit_form have no chapter check). Forms
// now follows My cases' rule from the same source: it says the member is not
// in a chapter yet and who sets chapters up, and starts no new form. Drafts
// the member already has stay listed and can be opened.

afterEach(cleanup);

const NOTE_TITLE = "You are not in a campaign yet";
const NOTE_BODY = "A form you send is reviewed in your campaign. An administrator of your organization sets up its campaigns and adds workers to them. Once you are in a campaign, you can start a form here.";
const draft = { id: "f-1", templateKey: "grievance", status: "draft", step: 0, answers: { summary: "Saved" }, cosigners: [] };

function renderForms({ chapterAvailable, forms = [], lang = "en", desktop = true, focus = null } = {}) {
  const data = { member: { id: "member-1", initials: "MG", chapterId: chapterAvailable === false ? null : "ch-1" }, forms };
  const props = chapterAvailable === undefined ? {} : { chapterAvailable };
  return render(<LanguageProvider lang={lang}><FormsView data={data} desktop={desktop} focus={focus} {...props} /></LanguageProvider>);
}

describe("Forms for a member in no chapter yet (#9594 D2-4)", () => {
  it("says why no form can be started, and offers no grievance report or other start", () => {
    for (const desktop of [true, false]) {
      const { container, unmount } = renderForms({ chapterAvailable: false, desktop });
      const note = container.querySelector("[data-forms-no-chapter]");
      expect(note).toHaveAttribute("role", "note");
      expect(note).toHaveTextContent(NOTE_TITLE);
      expect(note).toHaveTextContent(NOTE_BODY);
      expect(screen.queryByRole("button", { name: /Workplace issue report/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("does not open a new grievance report from a deep link", () => {
    renderForms({ chapterAvailable: false, focus: { templateKey: "grievance", nonce: 1 } });
    expect(screen.queryByText(/Step 1 of/)).not.toBeInTheDocument();
    expect(screen.getByText(NOTE_BODY, { exact: false })).toBeInTheDocument();
  });

  it("keeps a draft the member already has, and lets them open it", () => {
    renderForms({ chapterAvailable: false, forms: [draft] });
    const resume = screen.getByRole("button", { name: "Resume draft" });
    fireEvent.click(resume);
    expect(screen.queryByRole("button", { name: "Resume draft" })).not.toBeInTheDocument();
  });

  it("says the same in Spanish", () => {
    const { container } = renderForms({ chapterAvailable: false, lang: "es" });
    const note = container.querySelector("[data-forms-no-chapter]");
    expect(note).toHaveTextContent(t("es", "mforms.noChapterTitle"));
    expect(note).toHaveTextContent(t("es", "mforms.noChapterBody"));
    expect(t("es", "mforms.noChapterBody")).not.toBe(NOTE_BODY);
    expect(t("es", "mforms.noChapterBody")).toMatch(/administrador de tu organización/);
  });

  it("leaves a member in a chapter, and any caller that does not say, with the usual starts", () => {
    for (const chapterAvailable of [true, undefined]) {
      const { container, unmount } = renderForms({ chapterAvailable });
      expect(container.querySelector("[data-forms-no-chapter]")).toBeNull();
      expect(screen.getByRole("button", { name: /Workplace issue report/ })).toBeInTheDocument();
      unmount();
    }
  });

  it("is wired from the same source as My cases", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toMatch(/<FormsView[\s\S]{0,200}chapterAvailable=\{Boolean\(data\.member\?\.chapterId\)\}/);
    expect(app).toMatch(/<CasesView[^\n]*caseIntakeAvailable=\{Boolean\(data\.member\?\.chapterId\)\}/);
  });
});
