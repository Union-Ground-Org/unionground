import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { CaseHistoryTimeline } from "../src/components/CaseHistoryTimeline.jsx";
import { loadCaseHistory as loadCaseHistoryFrom } from "../src/lib/caseworkApi.js";

const item = { id: "case-1", reference: "GRV-1", title: "Schedule case", type: "Scheduling", articles: "", status: "active", step: "Intake", deadlineValue: "", updates: [], files: [] };
const second = { ...item, id: "case-2", reference: "GRV-2", title: "Overtime case" };
const note = (body, id = "saved") => ({ event_id: `note:${id}`, kind: "note", at: "2026-10-07T16:00:00Z", details: { body } });
const page = (...rows) => ({ rows, nextBefore: null });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function openCase({ loadCaseHistory, onAddCaseUpdate }) {
  const props = { data: { cases: [item, second] }, caseworkApi: { loadCaseHistory }, onAddCaseUpdate };
  const view = render(<CasesView {...props} focus={{ caseId: item.id, nonce: 1 }} />);
  return { ...view, props };
}
function submitNote(body = "New saved note") {
  const input = screen.getByPlaceholderText("Add an issue note…");
  fireEvent.change(input, { target: { value: body } });
  fireEvent.submit(input.form);
  return input;
}

describe("successful case note history refresh", () => {
  it("shows a committed note without a refreshed case projection or a second write", async () => {
    const save = deferred();
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page()).mockResolvedValue(page(note("New saved note")));
    const onAddCaseUpdate = vi.fn(() => save.promise);
    openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("No history yet.");
    const input = submitNote();
    // Submitting again while the write is pending cannot duplicate it.
    fireEvent.submit(input.form);
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("New saved note");
    expect(loadCaseHistory).toHaveBeenCalledTimes(1);
    await act(async () => save.resolve());
    const history = screen.getByRole("region", { name: "Issue history" });
    expect(await within(history).findByText("New saved note")).toBeInTheDocument();
    expect(within(history).getAllByText("New saved note")).toHaveLength(1);
    expect(input).toHaveValue("");
    expect(onAddCaseUpdate).toHaveBeenCalledWith("case-1", "New saved note", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
    expect(loadCaseHistory).toHaveBeenLastCalledWith("case-1", { before: null });
  });

  it("preserves a failed draft and refreshes history only after its successful retry", async () => {
    const save = deferred();
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page()).mockResolvedValue(page(note("Keep this draft")));
    const onAddCaseUpdate = vi.fn().mockReturnValueOnce(save.promise).mockResolvedValue(undefined);
    openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("No history yet.");
    const input = submitNote("Keep this draft");
    await act(async () => save.reject(new Error("write denied")));
    expect(input).toHaveValue("Keep this draft");
    expect(loadCaseHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Add note" })).toBeEnabled();
    fireEvent.submit(input.form);
    expect(await within(screen.getByRole("region", { name: "Issue history" })).findByText("Keep this draft")).toBeInTheDocument();
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(2);
  });

  it("retries a failed history read without writing the committed note again", async () => {
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error("read offline")).mockResolvedValue(page(note("New saved note")));
    const onAddCaseUpdate = vi.fn().mockResolvedValue(undefined);
    openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("No history yet.");
    const input = submitNote();
    expect(await screen.findByRole("alert")).toHaveTextContent("Issue history could not be loaded.");
    expect(input).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("New saved note")).toBeInTheDocument();
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])("ignores a stale pre-save history request that later %ss", async (settlement) => {
    const stale = deferred();
    const loadCaseHistory = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(page(note("New saved note")));
    openCase({ loadCaseHistory, onAddCaseUpdate: vi.fn().mockResolvedValue(undefined) });
    submitNote();
    expect(await screen.findByText("New saved note")).toBeInTheDocument();
    await act(async () => stale[settlement](settlement === "resolve" ? page(note("Stale history")) : new Error("old read failed")));
    expect(screen.getByText("New saved note")).toBeInTheDocument();
    expect(screen.queryByText("Stale history")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"])("leaves the newly selected case and its draft alone when the old save %ss", async (settlement) => {
    const save = deferred();
    const loadCaseHistory = vi.fn((id) => Promise.resolve(page(note(id === "case-1" ? "First history" : "Second history"))));
    const onAddCaseUpdate = vi.fn(() => save.promise);
    const view = openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("First history");
    submitNote();
    view.rerender(<CasesView {...view.props} focus={{ caseId: second.id, nonce: 2 }} />);
    await screen.findByText("Second history");
    const input = screen.getByPlaceholderText("Add an issue note…");
    fireEvent.change(input, { target: { value: "Second case draft" } });
    const reads = loadCaseHistory.mock.calls.length;
    await act(async () => save[settlement](settlement === "resolve" ? undefined : new Error("old write failed")));
    expect(screen.getByRole("dialog", { name: "Overtime case" })).toBeInTheDocument();
    expect(input).toHaveValue("Second case draft");
    expect(screen.getByText("Second history")).toBeInTheDocument();
    expect(loadCaseHistory).toHaveBeenCalledTimes(reads);
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not erase a newer draft typed while the previous note saves", async () => {
    const save = deferred();
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page()).mockResolvedValue(page(note("New saved note")));
    openCase({ loadCaseHistory, onAddCaseUpdate: vi.fn(() => save.promise) });
    await screen.findByText("No history yet.");
    const input = submitNote();
    fireEvent.change(input, { target: { value: "Next note draft" } });
    await act(async () => save.resolve());
    expect(input).toHaveValue("Next note draft");
    expect(await screen.findByText("New saved note")).toBeInTheDocument();
    // Only the earlier body was stored; the unsent sentence is not "saved".
    expect(screen.queryByText("Issue note saved")).not.toBeInTheDocument();
  });
});

describe("history request isolation", () => {
  it.each(["resolve", "reject"])("ignores a previous case request that %ss after the selected case loaded", async (settlement) => {
    const stale = deferred();
    const api = { loadCaseHistory: vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(page(note("Selected case history"))) };
    const view = render(<CaseHistoryTimeline caseId="case-1" api={api} />);
    view.rerender(<CaseHistoryTimeline caseId="case-2" api={api} />);
    await screen.findByText("Selected case history");
    await act(async () => stale[settlement](settlement === "resolve" ? page(note("Other case history")) : new Error("old request denied")));
    expect(screen.getByText("Selected case history")).toBeInTheDocument();
    expect(screen.queryByText("Other case history")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("discards an older-page response when a save refreshes the first page", async () => {
    const stale = deferred();
    const api = { loadCaseHistory: vi.fn().mockResolvedValueOnce({ ...page(note("Existing note")), nextBefore: "cursor" }).mockReturnValueOnce(stale.promise).mockResolvedValue(page(note("New saved note"), note("Existing note", "existing"))) };
    const view = render(<CaseHistoryTimeline caseId="case-1" api={api} refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier activity" }));
    view.rerender(<CaseHistoryTimeline caseId="case-1" api={api} refreshKey={1} />);
    await screen.findByText("New saved note");
    await act(async () => stale.resolve(page(note("Superseded page"))));
    expect(screen.queryByText("Superseded page")).not.toBeInTheDocument();
    expect(screen.getAllByText("Existing note")).toHaveLength(1);
    await waitFor(() => { expect(screen.getByRole("button", { name: "Refresh history" })).toBeEnabled(); expect((screen.getByRole("button", { name: "Refresh history" })).closest('[aria-disabled="true"]')).toBeNull(); });
  });
});

describe("saved notes during a slow or failed history refresh", () => {
  it("does not add a saved confirmation to the demo's history-free no-op writer", async () => {
    render(<CasesView data={{ cases: [item] }} caseworkApi={{}} onAddCaseUpdate={vi.fn().mockResolvedValue(null)} focus={{ caseId: item.id, nonce: 1 }} />);
    const input = submitNote();
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByText("Issue note saved")).not.toBeInTheDocument();
  });

  it("retains authorized history and confirms the save through a read failure and retry", async () => {
    const readback = deferred();
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page(note("Already visible")))
      .mockReturnValueOnce(readback.promise).mockResolvedValue(page(note("New saved note"), note("Already visible", "old")));
    const onAddCaseUpdate = vi.fn().mockResolvedValue(null);
    openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("Already visible");
    const input = submitNote();
    await waitFor(() => expect(loadCaseHistory).toHaveBeenCalledTimes(2));
    const history = screen.getByRole("region", { name: "Issue history" });
    expect(within(history).getByText("Already visible")).toBeInTheDocument();
    expect(screen.getByText("Issue note saved")).toHaveAttribute("role", "status");
    expect(within(history).queryByText("New saved note")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    await act(async () => readback.reject(new Error("offline")));
    expect(screen.getByText("Already visible")).toBeInTheDocument();
    expect(screen.getByText("Issue note saved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await within(history).findByText("New saved note");
    expect(within(history).getAllByText("Already visible")).toHaveLength(1);
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
  });

  it("blocks accidental resubmission until readback recovers, then allows an intentional successive note", async () => {
    const readback = deferred();
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page(note("Existing note")))
      .mockReturnValueOnce(readback.promise).mockResolvedValue(page(note("New saved note")));
    const onAddCaseUpdate = vi.fn().mockResolvedValue(null);
    openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("Existing note");
    submitNote();
    await waitFor(() => expect(loadCaseHistory).toHaveBeenCalledTimes(2));
    submitNote("  New saved note  ");
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("This note was already saved.");
    await act(async () => readback.reject(new Error("offline")));
    submitNote();
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("New saved note");
    submitNote();
    await waitFor(() => expect(onAddCaseUpdate).toHaveBeenCalledTimes(2));
  });

  it("allows an explicitly requested duplicate even when readback remains unavailable", async () => {
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page(note("Existing note")))
      .mockRejectedValue(new Error("offline"));
    const onAddCaseUpdate = vi.fn().mockResolvedValue(null);
    openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("Existing note");
    submitNote();
    await screen.findByText("Issue history could not be loaded.");
    submitNote();
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add another copy" }));
    await waitFor(() => expect(onAddCaseUpdate).toHaveBeenCalledTimes(2));
  });

  it("allows different successive notes and does not let an older read unlock a newer saved draft", async () => {
    const firstRead = deferred(), secondRead = deferred();
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page(note("Existing note")))
      .mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise);
    const onAddCaseUpdate = vi.fn().mockResolvedValue(null);
    openCase({ loadCaseHistory, onAddCaseUpdate });
    await screen.findByText("Existing note");
    submitNote("First saved note");
    await waitFor(() => expect(loadCaseHistory).toHaveBeenCalledTimes(2));
    submitNote("Second saved note");
    await waitFor(() => expect(loadCaseHistory).toHaveBeenCalledTimes(3));
    await act(async () => firstRead.resolve(page(note("First saved note"))));
    submitNote("Second saved note");
    expect(onAddCaseUpdate).toHaveBeenCalledTimes(2);
    await act(async () => secondRead.resolve(page(note("Second saved note"), note("First saved note", "first"))));
    expect(screen.getByText("Second saved note")).toBeInTheDocument();
    expect(screen.getByText("First saved note")).toBeInTheDocument();
    expect(screen.queryByText("This note was already saved.")).not.toBeInTheDocument();
  });

  it.each(["id", "organizationId", "chapterId", "membershipStatus"])("clears old history, draft and late save feedback when member %s changes", async (field) => {
    const save = deferred(), freshRead = deferred();
    const loadCaseHistory = vi.fn().mockResolvedValueOnce(page(note("Private original history")))
      .mockReturnValue(freshRead.promise);
    const member = { id: "member-1", organizationId: "org-1", chapterId: "chapter-1", membershipStatus: "active" };
    const props = { data: { member, cases: [item] }, caseworkApi: { loadCaseHistory }, onAddCaseUpdate: vi.fn(() => save.promise), focus: { caseId: item.id, nonce: 1 } };
    const view = render(<CasesView {...props} />);
    await screen.findByText("Private original history");
    submitNote("Original scope draft");
    view.rerender(<CasesView {...props} data={{ ...props.data, member: { ...member, [field]: "changed" } }} />);
    expect(screen.queryByText("Private original history")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add an issue note…")).toHaveValue("");
    await act(async () => save.resolve());
    expect(screen.queryByText("Issue note saved")).not.toBeInTheDocument();
    expect(loadCaseHistory).toHaveBeenCalledTimes(2);
    await act(async () => freshRead.resolve(page(note("Current scope history"))));
    expect(screen.getByText("Current scope history")).toBeInTheDocument();
  });

  it.each(["scopeKey", "api", "memberOnly"])("clears retained rows immediately when timeline %s changes", async (field) => {
    const readback = deferred();
    const api = { loadCaseHistory: vi.fn().mockResolvedValueOnce(page(note("Original private history"))).mockReturnValue(readback.promise) };
    const props = { caseId: "case-1", scopeKey: "identity-1:tenant-1", api, memberOnly: false };
    const view = render(<CaseHistoryTimeline {...props} />);
    await screen.findByText("Original private history");
    const changed = { scopeKey: "identity-2:tenant-2", api: { loadCaseHistory: api.loadCaseHistory }, memberOnly: true };
    view.rerender(<CaseHistoryTimeline {...props} {...{ [field]: changed[field] }} />);
    expect(screen.queryByText("Original private history")).not.toBeInTheDocument();
    await act(async () => readback.resolve(page()));
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
  });

  it.each(["42501", "28000", "PGRST301", "PGRST302", "PGRST303", "PT403"])("drops previously authorized rows on access refusal %s", async (code) => {
    const api = { loadCaseHistory: vi.fn().mockResolvedValueOnce(page(note("Previously authorized")))
      .mockRejectedValue(Object.assign(new Error("access refused"), { code })) };
    render(<CaseHistoryTimeline caseId="case-1" api={api} />);
    await screen.findByText("Previously authorized");
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Previously authorized")).not.toBeInTheDocument();
  });

  it.each([401, 403, 404])("drops previously authorized rows on an uncoded HTTP %s from the real loader", async (status) => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [note("Previously authorized")], error: null, status: 200 })
      .mockResolvedValue({ data: null, error: { message: "Unauthorized" }, status });
    const api = { loadCaseHistory: (caseId, options) => loadCaseHistoryFrom({ rpc }, caseId, options) };
    render(<CaseHistoryTimeline caseId="case-1" api={api} />);
    await screen.findByText("Previously authorized");
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Previously authorized")).not.toBeInTheDocument();
  });

  it("keeps previously authorized rows through an uncoded gateway 503 from the real loader", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [note("Previously authorized")], error: null, status: 200 })
      .mockResolvedValue({ data: null, error: { message: "Service Unavailable" }, status: 503 });
    const api = { loadCaseHistory: (caseId, options) => loadCaseHistoryFrom({ rpc }, caseId, options) };
    render(<CaseHistoryTimeline caseId="case-1" api={api} />);
    await screen.findByText("Previously authorized");
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Previously authorized")).toBeInTheDocument();
  });

  it("does not let an old-scope access refusal clear a newly authorized scope", async () => {
    const stale = deferred();
    const api = { loadCaseHistory: vi.fn().mockResolvedValueOnce(page(note("Old scope")))
      .mockReturnValueOnce(stale.promise).mockResolvedValue(page(note("Current scope"))) };
    const view = render(<CaseHistoryTimeline caseId="case-1" scopeKey="old" api={api} />);
    await screen.findByText("Old scope");
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    view.rerender(<CaseHistoryTimeline caseId="case-1" scopeKey="current" api={api} />);
    await screen.findByText("Current scope");
    await act(async () => stale.reject(Object.assign(new Error("old access refused"), { code: "42501" })));
    expect(screen.getByText("Current scope")).toBeInTheDocument();
    expect(screen.queryByText("Old scope")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
