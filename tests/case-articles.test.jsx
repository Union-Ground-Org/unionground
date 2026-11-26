import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { CaseHistoryTimeline } from "../src/components/CaseHistoryTimeline.jsx";
import { CasesView } from "../src/views/CasesView.jsx";
import { CaseArticlesEditor } from "../src/features/caseIntake/CaseArticlesEditor.jsx";
import { coordinatorUpdateCase } from "../src/lib/memberApi.js";

afterEach(() => window.history.replaceState({}, "", "/m/steward"));
const item = { id: "case-1", reference: "GR-ARTICLES", title: "Schedule review", memberName: "Test worker", memberInitials: "TM", caseType: "other", articles: "Article 12", status: "active", step: "Intake", deadline: null, updates: [] };

describe("issue articles in the issue dialog", () => {

  it("disables the form during a save and retains the draft after a refused write", async () => {
    let refuse;
    const onUpdate = vi.fn(() => new Promise((resolve, reject) => { refuse = reject; }));
    render(<LanguageProvider lang="en"><CaseArticlesEditor item={item} onUpdate={onUpdate} /></LanguageProvider>);
    const field = screen.getByRole("textbox", { name: "Contract articles" });
    fireEvent.change(field, { target: { value: "Article 7" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for change" }), { target: { value: "Correction" } });
    fireEvent.click(screen.getByRole("button", { name: "Save articles" }));
    expect((field).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(field);
    expect((screen.getByRole("button", { name: /Saving/ })).closest('[aria-disabled="true"]')).not.toBeNull();
    refuse({ code: "42501" });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(field).toHaveValue("Article 7");
    expect(field).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("forwards explicit empty/null articles and leaves omitted articles out of the existing RPC call", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    const fields = { status: "active", deadline: "", reason: "Contract correction" };
    for (const articles of ["Article 3", "", null]) {
      await coordinatorUpdateCase({ rpc }, item.id, { ...fields, articles });
      expect(rpc).toHaveBeenLastCalledWith("coordinator_update_case", expect.objectContaining({ p_articles: articles }));
    }
    await coordinatorUpdateCase({ rpc }, item.id, fields);
    expect(rpc.mock.lastCall[1]).not.toHaveProperty("p_articles");
  });

  it.each(["en", "es"])("shows article before/after values in the staff history in %s", async (lang) => {
    const api = { loadCaseHistory: vi.fn().mockResolvedValue({ rows: [{ event_id: "articles:1", kind: "coordinator", at: "2026-11-05T18:00:00Z", details: { action: "case_updated", before: { articles: "Article 12" }, after: { articles: "Article 3" }, reason: "Correction" } }], nextBefore: null }) };
    render(<LanguageProvider lang={lang}><CaseHistoryTimeline caseId={item.id} api={api} /></LanguageProvider>);
    expect(await screen.findByText("Article 3")).toBeInTheDocument();
    expect(screen.getByText("Article 12")).toBeInTheDocument();
    expect(screen.getByText(lang === "es" ? "Artículos del contrato" : "Contract articles")).toBeInTheDocument();
  });
});
