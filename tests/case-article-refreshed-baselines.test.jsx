import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { caseListOpenerName } from "./helpers/case-list-opener.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CaseArticlesEditor } from "../src/features/caseIntake/CaseArticlesEditor.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

afterEach(() => clearDeviceParityState());

function openEditor(lang = "en") {
  const onUpdate = vi.fn(async (_id, fields) => ({ articles: fields.articles.trim() }));
  const item = { id: "case-1", articles: "Article A" };
  const view = (changes) => <LanguageProvider lang={lang}><CaseArticlesEditor item={{ ...item, ...changes }} onUpdate={onUpdate} /></LanguageProvider>;
  const rendered = render(view({}));
  const field = screen.getByRole("textbox", { name: lang === "es" ? "Artículos del contrato" : "Contract articles" });
  const reason = screen.getByRole("textbox", { name: lang === "es" ? "Motivo del cambio" : "Reason for change" });
  const save = screen.getByRole("button", { name: lang === "es" ? "Guardar artículos" : "Save articles" });
  fireEvent.change(reason, { target: { value: "Correct reference" } });
  return { field, save, onUpdate, refresh: (changes) => rendered.rerender(view(changes)) };
}

it.each(["en", "es"])("refreshes pristine articles and allows an intentional restoration in %s", async (lang) => {
  const { field, save, refresh, onUpdate } = openEditor(lang);
  refresh({ articles: "Article B" });
  expect(field).toHaveValue("Article B");
  expect(save).toBeDisabled();
  fireEvent.change(field, { target: { value: "Article A" } });
  expect(save).toBeEnabled();
  await expectHeldWriteFocus(onUpdate, save);
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("case-1", { articles: "Article A", reason: "Correct reference" }));
  await waitFor(() => expect(save).toBeDisabled());
});

it.each(["Article C", ""])("keeps the unsaved article draft %j and allows restoring the original value", async (draft) => {
  const { field, save, refresh, onUpdate } = openEditor();
  fireEvent.change(field, { target: { value: draft } });
  refresh({ articles: "Article B" });
  expect(field).toHaveValue(draft);
  expect(save).toBeEnabled();
  expect(onUpdate).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "Article A" } });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("case-1", { articles: "Article A", reason: "Correct reference" }));
});

it("marks an article draft clean when another save has already stored it", () => {
  const { field, save, refresh, onUpdate } = openEditor();
  fireEvent.change(field, { target: { value: "Article B" } });
  refresh({ articles: "Article B" });
  expect(field).toHaveValue("Article B");
  expect(save).toBeDisabled();
  fireEvent.click(save);
  expect(onUpdate).not.toHaveBeenCalled();
});

it("reconciles a server clear without losing the ability to restore articles", async () => {
  const { field, save, refresh, onUpdate } = openEditor();
  refresh({ articles: null });
  expect(field).toHaveValue("");
  expect(save).toBeDisabled();
  fireEvent.change(field, { target: { value: "Article A" } });
  fireEvent.click(save);
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("case-1", { articles: "Article A", reason: "Correct reference" }));
});

it("keeps its confirmed save when unrelated props still carry the old article value", async () => {
  const { field, save, refresh, onUpdate } = openEditor();
  fireEvent.change(field, { target: { value: "Article B" } });
  fireEvent.click(save);
  await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(save).toBeDisabled());
  refresh({ articles: "Article A", status: "resolved" });
  expect(field).toHaveValue("Article B");
  expect(save).toBeDisabled();
});

async function openCoordinator(update = null) {
  window.history.replaceState({}, "", "/m/coordinator");
  const desk = structuredClone(fallbackData.coordinatorDesk);
  desk.cases = [{ ...desk.cases[0], articles: "Article A", status: "active", deadline: "2026-12-01", deadlineLabel: "Original deadline", updates: [], files: [] }];
  const item = desk.cases[0];
  const api = {
    loadDesk: vi.fn(async () => structuredClone(desk)),
    loadCases: vi.fn(async () => ({ cases: structuredClone(desk.cases), nextCursor: null })),
    addCaseNote: vi.fn(async () => {}),
    updateCase: vi.fn(update || (async (_id, fields) => { Object.assign(item, fields); return { ...item }; })),
  };
  const { container } = render(<LanguageProvider lang="en"><CoordinatorView data={{ member: { initials: "TC" } }} api={api} /></LanguageProvider>);
  fireEvent.click(await screen.findByRole("button", { name: caseListOpenerName(item) }));
  const form = container.querySelector("form.gq-write__form");
  const field = (name) => form.elements.namedItem(name);
  fireEvent.change(field("reason"), { target: { value: "Correct reference" } });
  const refresh = async (changes) => {
    Object.assign(item, changes);
    const reads = api.loadDesk.mock.calls.length;
    const note = container.querySelector('[name="note"]');
    fireEvent.change(note, { target: { value: "Refresh the case projection" } });
    fireEvent.submit(note.form);
    await waitFor(() => expect(api.loadDesk.mock.calls.length).toBeGreaterThan(reads));
    if (changes.articles) await screen.findByText(changes.articles, { selector: ".gq-fact strong" });
    if (changes.deadline) await screen.findByText(new Date(`${changes.deadline}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }), { selector: ".gq-fact strong" });
    expect(container.querySelector("form.gq-write__form")).toBe(form);
  };
  return { api, form, field, refresh, item };
}






it("does not reset a confirmed coordinator article save from an unchanged stale prop", async () => {
  const { api, form, field, refresh } = await openCoordinator(async () => ({ articles: "Article B" }));
  fireEvent.change(field("articles"), { target: { value: "Article B" } });
  fireEvent.submit(form);
  await waitFor(() => expect(api.updateCase).toHaveBeenCalledTimes(1));
  // A pending control stays enabled (record 8435): wait for its busy state to clear.
  await waitFor(() => { const control = within(form).getByRole("button", { name: "Save changes" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
  await refresh({ deadline: "2026-12-05", deadlineLabel: "Refreshed deadline" });
  expect(field("articles")).toHaveValue("Article B");
  expect(field("deadline")).toHaveValue("2026-12-05");
});
