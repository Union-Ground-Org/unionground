import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { caseListOpenerName } from "./helpers/case-list-opener.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { CaseArticlesEditor } from "../src/features/caseIntake/CaseArticlesEditor.jsx";
import { coordinatorUpdateCase } from "../src/lib/memberApi.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

afterEach(() => clearDeviceParityState());
async function openCoordinator(extra = {}, caseChanges = {}) {
  const seed = structuredClone(fallbackData.coordinatorDesk);
  seed.cases = [{ ...seed.cases[0], articles: "Article A", status: "active", deadline: "2026-12-01", ...caseChanges }];
  const api = {
    loadDesk: vi.fn(async () => structuredClone(seed)),
    loadCases: vi.fn(async () => ({ cases: structuredClone(seed.cases), nextCursor: null })),
    updateCase: vi.fn().mockResolvedValue({}),
    ...extra,
  };
  const { container } = render(<LanguageProvider lang="en"><CoordinatorView data={{ member: { initials: "TC" } }} api={api} /></LanguageProvider>);
  fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(seed.cases[0]) }));
  const form = container.querySelector("form.gq-write__form");
  return { api, form, seed, container };
}

it.each([
  ["deadline", "2026-12-02"],
  ["status", "resolved"],
  ["articles", "Article C"],
])("the campaign lead sends only the edited %s field", async (name, value) => {
  const { api, form, seed } = await openCoordinator();
  fireEvent.change(form.elements.namedItem(name), { target: { value } });
  fireEvent.change(form.elements.namedItem("reason"), { target: { value: "Correction" } });
  fireEvent.submit(form);
  await waitFor(() => expect(api.updateCase).toHaveBeenCalledWith(seed.cases[0].id, { [name]: value, reason: "Correction" }));
});

it("keeps a newer article correction during a deadline-only campaign lead save", async () => {
  let currentArticles = "Article B";
  const updateCase = vi.fn(async (_id, fields) => {
    if (Object.hasOwn(fields, "articles")) currentArticles = fields.articles;
    return { status: "resolved", deadline: "2026-12-02", articles: currentArticles };
  });
  const { form } = await openCoordinator({ updateCase });
  fireEvent.change(form.elements.namedItem("deadline"), { target: { value: "2026-12-02" } });
  fireEvent.change(form.elements.namedItem("reason"), { target: { value: "Extend deadline" } });
  fireEvent.submit(form);
  await waitFor(() => expect(updateCase).toHaveBeenCalled());
  expect(currentArticles).toBe("Article B");
});

it("the dedicated editor sends article intent without stale workflow fields", async () => {
  const onUpdate = vi.fn().mockResolvedValue({ articles: "Article B", status: "resolved", deadline: "2026-12-04" });
  render(<LanguageProvider lang="en"><CaseArticlesEditor item={{ id: "case-1", articles: "Article A", status: "active", deadline: "2026-12-01" }} onUpdate={onUpdate} /></LanguageProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: "Contract articles" }), { target: { value: "Article B" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Reason for change" }), { target: { value: "Correct reference" } });
  fireEvent.click(screen.getByRole("button", { name: "Save articles" }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("case-1", { articles: "Article B", reason: "Correct reference" }));
});

it("does not submit an untouched article snapshot", async () => {
  const onUpdate = vi.fn();
  render(<LanguageProvider lang="en"><CaseArticlesEditor item={{ id: "case-1", articles: "Article A", status: "active" }} onUpdate={onUpdate} /></LanguageProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason for change" }), { target: { value: "Unrelated reason" } });
  fireEvent.click(screen.getByRole("button", { name: "Save articles" }));
  expect(onUpdate).not.toHaveBeenCalled();
});

it("does not turn background record refreshes into article edits", async () => {
  const onUpdate = vi.fn();
  const { rerender } = render(<LanguageProvider lang="en"><CaseArticlesEditor item={{ id: "case-1", articles: "Article A", status: "active" }} onUpdate={onUpdate} /></LanguageProvider>);
  rerender(<LanguageProvider lang="en"><CaseArticlesEditor item={{ id: "case-1", articles: "Article B", status: "resolved" }} onUpdate={onUpdate} /></LanguageProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason for change" }), { target: { value: "No article edit" } });
  expect(screen.getByRole("button", { name: "Save articles" })).toBeDisabled();
  expect(onUpdate).not.toHaveBeenCalled();
});

it("omits absent workflow arguments at the RPC boundary", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
  await coordinatorUpdateCase({ rpc }, "case-1", { articles: "Article B", reason: "Correction" });
  expect(rpc).toHaveBeenCalledWith("coordinator_update_case", { p_case_id: "case-1", p_step: null, p_articles: "Article B", p_reason: "Correction" });
});

it("distinguishes an omitted deadline from an explicit clear at the RPC boundary", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
  await coordinatorUpdateCase({ rpc }, "case-1", { status: "resolved", reason: "Resolve" });
  expect(rpc.mock.lastCall[1]).not.toHaveProperty("p_deadline");
  for (const deadline of ["", null]) {
    await coordinatorUpdateCase({ rpc }, "case-1", { deadline, reason: "Attempt clear" });
    expect(rpc.mock.lastCall[1]).toMatchObject({ p_deadline: null });
    expect(rpc.mock.lastCall[1]).not.toHaveProperty("p_status");
  }
});

it.each([true, false])("refreshes campaign lead history after a save with issue tools %s", async (withTools) => {
  let rows = [];
  const loadCaseHistory = vi.fn(async () => ({ rows: structuredClone(rows), nextBefore: null }));
  const { form } = await openCoordinator({
    ...(withTools ? { loadCaseworkCase: vi.fn(async (id) => ({ scope: { id, step: "Intake" }, strength: [], deadlines: [], checklists: [], transitions: [], alerts: [], management: [], retaliation: [], links: [], reminders: [] })) } : {}),
    loadCaseHistory,
    updateCase: vi.fn(async () => {
      rows = [{ event_id: "articles:new", kind: "campaign lead", at: "2026-11-05T20:00:00Z", details: { action: "case_updated", before: { articles: "Article A" }, after: { articles: "Article B" }, reason: "Visible saved correction" } }];
      return { articles: "Article B" };
    }),
  });
  await waitFor(() => expect(loadCaseHistory).toHaveBeenCalledTimes(1));
  fireEvent.change(form.elements.namedItem("articles"), { target: { value: "Article B" } });
  fireEvent.change(form.elements.namedItem("reason"), { target: { value: "Correction" } });
  fireEvent.submit(form);
  expect(await screen.findByText("Visible saved correction")).toBeInTheDocument();
  expect(loadCaseHistory.mock.calls.length).toBeGreaterThan(1);
  expect(within(form).getByRole("textbox", { name: "Contract articles" })).toHaveValue("Article B");
});

it.each(["note", "contact", "outcome", "mention", "assignment", "file"])("refreshes campaign lead history after the parallel %s write", async (kind) => {
  let committed = false;
  const write = vi.fn(async () => { committed = true; });
  const loadCaseHistory = vi.fn(async () => ({ rows: committed ? [{ event_id: `${kind}:new`, kind: "note", at: "2026-11-05T20:00:00Z", details: { body: `Committed ${kind} history` } }] : [], nextBefore: null }));
  const extra = {
    loadCaseHistory,
    addCaseNote: write, logCaseContact: write, recordCaseOutcome: write,
    ...(kind === "mention" ? { addCaseNoteWithMentions: write, loadMentionCandidates: vi.fn(async () => []) } : {}),
    ...(kind === "assignment" ? { assignCase: write, loadAssignmentCandidates: vi.fn(async () => []) } : {}),
    ...(kind === "file" ? { openCaseFile: vi.fn(), removeCaseFile: write } : {}),
  };
  const { container } = await openCoordinator(extra, kind === "file" ? { files: [{ id: "file-1", filename: "Contract.pdf", sizeBytes: 123 }] } : {});
  await waitFor(() => expect(loadCaseHistory).toHaveBeenCalledTimes(1));
  if (kind === "assignment") {
    const form = await waitFor(() => {
      const element = container.querySelector("form.gq-assignment");
      expect(element).toBeTruthy(); return element;
    });
    fireEvent.submit(form);
  } else if (kind === "file") {
    // Fixture case files exercise the removal path without an upload scanner.
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove: / })[0]);
  } else if (kind === "mention") {
    const field = screen.getByRole("combobox", { name: "Issue note" });
    fireEvent.change(field, { target: { value: "Mention-aware note" } });
    fireEvent.submit(field.form);
  } else {
    const field = container.querySelector(`[name="${kind === "note" ? "note" : "summary"}"]`);
    const form = kind === "outcome" ? container.querySelector("form.gq-write__form--outcome") : field.form;
    if (kind === "contact") {
      const contact = container.querySelector('[name="contactedAt"]');
      fireEvent.change(contact, { target: { value: "2026-11-05T12:00" } });
    }
    fireEvent.submit(form);
  }
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(await within(screen.getByRole("region", { name: "Issue history" })).findByText(`Committed ${kind} history`)).toBeInTheDocument();
});

it("keeps the assignment's save control focused while the assignment is saved (record 8435)", async () => {
  const assignCase = vi.fn(async () => ({}));
  const { container } = await openCoordinator({ assignCase, loadAssignmentCandidates: vi.fn(async () => []), loadCaseHistory: vi.fn(async () => ({ rows: [], nextCursor: null })) });
  const form = await waitFor(() => { const element = container.querySelector("form.gq-assignment"); expect(element).toBeTruthy(); return element; });
  const save = form.querySelector('button[type="submit"], button:not([type])');
  await expectHeldWriteFocus(assignCase, save, () => fireEvent.submit(form));
  expect(assignCase).toHaveBeenCalledTimes(1);
});

it("keeps a issue note's save control focused while the note is saved (record 8435)", async () => {
  const addCaseNote = vi.fn(async () => ({}));
  const { container } = await openCoordinator({ addCaseNote, logCaseContact: vi.fn(), recordCaseOutcome: vi.fn(), loadCaseHistory: vi.fn(async () => ({ rows: [], nextCursor: null })) });
  const field = container.querySelector('[name="note"]');
  fireEvent.change(field, { target: { value: "Called the worker back." } });
  const save = field.form.querySelector('button[type="submit"], button:not([type])');
  await expectHeldWriteFocus(addCaseNote, save);
  expect(addCaseNote).toHaveBeenCalledTimes(1);
});

// Record 8435 (review P3-1 of #8887): while one case write runs, every other
// case write control on the desk is pending and refuses activation: the
// status field, Save changes, Log contact and Record outcome send nothing.
it("refuses the issue desk's other writes while one issue write runs", async () => {
  let release;
  const addCaseNote = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  const logCaseContact = vi.fn(async () => ({}));
  const recordCaseOutcome = vi.fn(async () => ({}));
  const { api, container } = await openCoordinator({ addCaseNote, logCaseContact, recordCaseOutcome, loadCaseHistory: vi.fn(async () => ({ rows: [], nextCursor: null })) });
  // Every other form is complete first, so only the lock,
  // not a missing required field, can stop its write.
  const fieldIn = (form, name) => form.querySelector(`[name="${name}"]`);
  const factsForm = container.querySelector('[name="status"]').form;
  fireEvent.change(fieldIn(factsForm, "reason"), { target: { value: "Worker update" } });
  const contactForm = container.querySelector('[name="contactedAt"]').form;
  fireEvent.change(fieldIn(contactForm, "contactedAt"), { target: { value: "2026-08-13T10:30" } });
  fireEvent.change(fieldIn(contactForm, "summary"), { target: { value: "Reviewed deadline" } });
  const outcomeForm = container.querySelector('[name="outcome"]').form;
  fireEvent.change(fieldIn(outcomeForm, "summary"), { target: { value: "Settlement signed" } });
  for (const box of outcomeForm.querySelectorAll('input[type="checkbox"][required]')) fireEvent.click(box);
  for (const form of [factsForm, contactForm, outcomeForm]) expect(form.checkValidity()).toBe(true);

  const note = container.querySelector('[name="note"]');
  fireEvent.change(note, { target: { value: "Called the worker back." } });
  fireEvent.click(note.form.querySelector('button[type="submit"], button:not([type])'));
  await waitFor(() => expect(addCaseNote).toHaveBeenCalledTimes(1));

  const status = container.querySelector('[name="status"]');
  expect(status).toHaveAttribute("aria-disabled", "true");
  const submitOf = (field) => container.querySelector(`[name="${field}"]`).form.querySelector('button[type="submit"], button:not([type])');
  for (const field of ["status", "summary", "outcome"]) {
    const control = submitOf(field);
    expect(control).toBeEnabled();
    expect(control).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(control);
  }
  expect(api.updateCase).not.toHaveBeenCalled();
  expect(logCaseContact).not.toHaveBeenCalled();
  expect(recordCaseOutcome).not.toHaveBeenCalled();
  await act(async () => { release({}); });
});
