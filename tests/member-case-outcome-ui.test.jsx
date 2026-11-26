import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { caseOutcomeCatalogue, caseOutcomeLabelKey, caseOutcomeT } from "../src/lib/i18n/caseOutcome.js";
import { loadMyCaseOutcome } from "../src/lib/caseworkApi.js";

// BUG-UG-MEMBER-NEVER-SEES-GRIEVANCE-OUTCOME-20261106 (#7195): the
// member saw "Resolved" and nothing else. The case dialog now shows the
// recorded outcome and its summary in the member's language.

const item = {
  id: "case-1", reference: "GR-2026-1", title: "Schedule grievance", type: "Scheduling", articles: "Article 7",
  status: "resolved", step: "Step 2", deadline: "Not set", deadlineValue: "", overdue: false,
  updates: [], files: [],
};
const outcome = { outcome: "settled", summary: "Back pay restored for the missed shifts.", recordedAt: "2026-11-06T15:00:00Z", updatedAt: "2026-11-06T15:00:00Z" };
const handlers = { onCreateCase: vi.fn(), onUpdateCase: vi.fn(), onAddCaseUpdate: vi.fn(), onAddCaseFile: vi.fn(), onRemoveCaseFile: vi.fn(), onOpenCaseFile: vi.fn() };

function openCase(lang, loadCaseOutcome) {
  window.history.replaceState({}, "", "/m/cases?case=case-1");
  render(
    <LanguageProvider lang={lang}>
      <CasesView data={{ cases: [item] }} {...handlers} caseworkApi={{ loadCaseOutcome }} />
    </LanguageProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("member case outcome", () => {
  it("shows the outcome type and summary on the member's case", async () => {
    const loadCaseOutcome = vi.fn().mockResolvedValue(outcome);
    openCase("en", loadCaseOutcome);
    const dialog = await screen.findByRole("dialog", { name: "Schedule grievance" });
    const block = await within(dialog).findByRole("region", { name: "How your case ended" });
    expect(within(block).getByText("Settled")).toBeInTheDocument();
    expect(within(block).getByText("Back pay restored for the missed shifts.")).toBeInTheDocument();
    expect(within(block).getByText(/Recorded Nov 6/)).toBeInTheDocument();
    expect(loadCaseOutcome).toHaveBeenCalledWith("case-1");
  });

  it("shows the Spanish labels to a Spanish-language member", async () => {
    openCase("es", vi.fn().mockResolvedValue({ ...outcome, outcome: "denied" }));
    const block = await screen.findByRole("region", { name: "Cómo terminó tu caso" });
    expect(within(block).getByText("Denegado")).toBeInTheDocument();
    expect(within(block).getByText(/Registrado el/)).toBeInTheDocument();
  });

  // #9984: a refusal for role or scope still shows nothing; any other failed
  // read says so (tests/member-case-outcome-load-failure.test.jsx).
  it("shows nothing before an outcome is recorded or when the read is refused", async () => {
    for (const loadCaseOutcome of [vi.fn().mockResolvedValue(null), vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: "42501" }))]) {
      openCase("en", loadCaseOutcome);
      await screen.findByRole("dialog", { name: "Schedule grievance" });
      await waitFor(() => expect(loadCaseOutcome).toHaveBeenCalled());
      expect(screen.queryByRole("region", { name: "How your case ended" })).not.toBeInTheDocument();
      document.body.innerHTML = "";
    }
  });

  it("omits the recorded date when the row carries none, and ignores a read that lands after the dialog closed", async () => {
    openCase("en", vi.fn().mockResolvedValue({ outcome: "withdrawn", summary: "The member withdrew the grievance.", recordedAt: null, updatedAt: null }));
    const block = await screen.findByRole("region", { name: "How your case ended" });
    expect(within(block).getByText("Withdrawn")).toBeInTheDocument();
    expect(within(block).queryByText(/Recorded/)).not.toBeInTheDocument();
    document.body.innerHTML = "";

    let release;
    const late = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    window.history.replaceState({}, "", "/m/cases?case=case-1");
    const view = render(<LanguageProvider lang="en"><CasesView data={{ cases: [item] }} {...handlers} caseworkApi={{ loadCaseOutcome: late }} /></LanguageProvider>);
    await screen.findByRole("dialog", { name: "Schedule grievance" });
    await waitFor(() => expect(late).toHaveBeenCalled());
    view.unmount();
    release(outcome);
    await Promise.resolve();
    expect(screen.queryByRole("region", { name: "How your case ended" })).not.toBeInTheDocument();
  });

  it("shows no outcome on a reopened case, whose earlier outcome row is kept (gate r2s2)", async () => {
    const loadCaseOutcome = vi.fn().mockResolvedValue(outcome);
    window.history.replaceState({}, "", "/m/cases?case=case-1");
    render(<LanguageProvider lang="en"><CasesView data={{ cases: [{ ...item, status: "active" }] }} {...handlers} caseworkApi={{ loadCaseOutcome }} /></LanguageProvider>);
    await screen.findByRole("dialog", { name: "Schedule grievance" });
    await Promise.resolve();
    expect(loadCaseOutcome).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "How your case ended" })).not.toBeInTheDocument();
  });

  it("re-reads the outcome when the case projection refreshes, so a correction that keeps the case resolved shows (gate r2s3)", async () => {
    const loadCaseOutcome = vi.fn().mockResolvedValue(outcome);
    window.history.replaceState({}, "", "/m/cases?case=case-1");
    const view = render(<LanguageProvider lang="en"><CasesView data={{ cases: [item] }} {...handlers} caseworkApi={{ loadCaseOutcome }} /></LanguageProvider>);
    const block = await screen.findByRole("region", { name: "How your case ended" });
    expect(within(block).getByText("Settled")).toBeInTheDocument();
    loadCaseOutcome.mockResolvedValue({ ...outcome, outcome: "denied", summary: "Corrected: the grievance was denied." });
    view.rerender(<LanguageProvider lang="en"><CasesView data={{ cases: [{ ...item, updates: [] }] }} {...handlers} caseworkApi={{ loadCaseOutcome }} /></LanguageProvider>);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "How your case ended" })).getByText("Denied")).toBeInTheDocument());
    expect(screen.getByText("Corrected: the grievance was denied.")).toBeInTheDocument();
    expect(loadCaseOutcome).toHaveBeenCalledTimes(2);
  });

  it("labels every stored outcome in EN and ES, and an unknown value as Other", () => {
    for (const [kind, en, es] of [["upheld", "Upheld", "Sostenido"], ["settled", "Settled", "Acuerdo"], ["withdrawn", "Withdrawn", "Retirado"], ["denied", "Denied", "Denegado"], ["other", "Other", "Otro"]]) {
      expect(caseOutcomeT("en", caseOutcomeLabelKey(kind))).toBe(en);
      expect(caseOutcomeT("es", caseOutcomeLabelKey(kind))).toBe(es);
    }
    for (const unknown of ["dismissed", "__proto__", "toString", null]) expect(caseOutcomeLabelKey(unknown)).toBe("caseOutcome.kind.other");
    // Both languages declare the same keys, and none lives in the barrel.
    expect(Object.keys(caseOutcomeCatalogue.es).sort()).toEqual(Object.keys(caseOutcomeCatalogue.en).sort());
    for (const key of Object.keys(caseOutcomeCatalogue.en)) expect(catalogue.en[key]).toBeUndefined();
  });

  it("reads the outcome by case id and maps it, or returns null", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), limit: vi.fn() };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
    query.limit.mockResolvedValue({ data: [{ outcome: "upheld", summary: "Discipline removed.", recorded_at: "a", updated_at: "b" }], error: null });
    const client = { from: vi.fn(() => query) };
    expect(await loadMyCaseOutcome(client, "case-1")).toEqual({ outcome: "upheld", summary: "Discipline removed.", recordedAt: "a", updatedAt: "b" });
    expect(client.from).toHaveBeenCalledWith("member_case_outcomes");
    expect(query.select).toHaveBeenCalledWith("outcome,summary,recorded_at,updated_at");
    expect(query.eq).toHaveBeenCalledWith("case_id", "case-1");
    query.limit.mockResolvedValue({ data: [], error: null });
    expect(await loadMyCaseOutcome(client, "case-1")).toBeNull();
    query.limit.mockResolvedValue({ data: null, error: { message: "permission denied", code: "42501" } });
    await expect(loadMyCaseOutcome(client, "case-1")).rejects.toThrow();
    await expect(loadMyCaseOutcome(client, "")).rejects.toThrow("Case id required");
  });

  it("re-reads the cached case projection when the member opens a case.resolved notice (gate r3s1/r4s1)", () => {
    // The loader behaviour is proved in tests/member-resource-registry.test.js;
    // this pins the App's notice-open handler to it, ahead of navigation.
    const app = readFileSync(resolve(import.meta.dirname, "../src/App.jsx"), "utf8");
    expect(app).toContain("onOpenDestination={(destination, item) => { setNotificationsOpen(false); const staleResources = notificationRefreshResources(item); if (staleResources.length) memberLoaderRef.current?.invalidateResources(staleResources); notificationOpenCounter.current += 1;");
  });

  it("tells the coordinator the member will see the outcome and summary", () => {
    expect(caseOutcomeT("en", "caseOutcome.coordinatorConfirm")).toBe("I confirm this outcome will resolve the case. The member will see the outcome and summary.");
    expect(caseOutcomeT("es", "caseOutcome.coordinatorConfirm")).toBe("Confirmo que este resultado resolverá el caso. El miembro verá el resultado y el resumen.");
  });
});
