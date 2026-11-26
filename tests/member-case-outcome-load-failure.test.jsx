import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
// BUG-UG-MEMBER-CASE-OUTCOME-VANISHES-ON-A-FAILED-READ-20261125 (#9984,
// from #9465): a member's resolved case turned a failed outcome read into "no
// outcome" and showed no How your case ended section, the same as a case whose
// outcome was never recorded. A refusal for role or scope still shows nothing;
// any other failure says so, with Try again. Fictional data.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const item = {
  id: "case-alder-3", reference: "GR-2026-31", title: "Overtime rotation grievance", type: "Scheduling", articles: "Article 12",
  status: "resolved", step: "Step 2", deadline: "Not set", deadlineValue: "", overdue: false, updates: [], files: [],
};
const outcome = { outcome: "settled", summary: "Overtime offers return to the posted rotation.", recordedAt: "2026-11-06T15:00:00Z", updatedAt: "2026-11-06T15:00:00Z" };
const handlers = { onCreateCase: vi.fn(), onUpdateCase: vi.fn(), onAddCaseUpdate: vi.fn(), onAddCaseFile: vi.fn(), onRemoveCaseFile: vi.fn(), onOpenCaseFile: vi.fn() };
const offline = () => Object.assign(new Error("Load outcome: Failed to fetch"), { code: null });
const refusal = () => Object.assign(new Error("Load outcome: permission denied"), { code: "42501" });
const TITLE = "How your case ended";
const LOAD_ERROR = "The outcome of your case could not be loaded.";

function view(loadCaseOutcome, lang = "en", caseItem = item) {
  return <LanguageProvider lang={lang}><CasesView data={{ cases: [caseItem] }} {...handlers} caseworkApi={{ loadCaseOutcome }} /></LanguageProvider>;
}
function openCase(loadCaseOutcome, lang = "en") {
  window.history.replaceState({}, "", `/m/cases?case=${item.id}`);
  return render(view(loadCaseOutcome, lang));
}
// A read whose outcome the test switches between calls; held by mockImplementation, never a queued Once value.
function switchableRead(first) {
  let next = first;
  const read = vi.fn(async () => { if (next instanceof Error) throw next; return next; });
  return { read, set: (value) => { next = value; } };
}
function held(result) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { run: async () => { await gate; if (result instanceof Error) throw result; return result; }, release: () => release() };
}
async function settle() {
  await act(async () => {});
  await act(async () => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("a member's case outcome after a failed read", () => {
  it("says it could not be loaded, keeps focus on Try again while it reads again, then shows it with focus on the heading", async () => {
    const { read, set } = switchableRead(offline());
    openCase(read);
    const block = await screen.findByRole("region", { name: TITLE });
    expect(within(block).getByRole("alert")).toHaveTextContent(LOAD_ERROR);
    set(outcome);
    await expectHeldWriteFocus(read, within(block).getByRole("button", { name: "Try again" }));
    expect(await within(block).findByText("Settled")).toBeInTheDocument();
    expect(within(block).getByText("Overtime offers return to the posted rotation.")).toBeInTheDocument();
    expect(within(block).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(block).getByRole("heading", { name: TITLE })).toHaveFocus();
    expect(read).toHaveBeenCalledWith("case-alder-3");
  });

  it("says in Spanish when a retry finds no outcome to show, without claiming none was recorded", async () => {
    const { read, set } = switchableRead(offline());
    openCase(read, "es");
    const block = await screen.findByRole("region", { name: "Cómo terminó tu caso" });
    expect(within(block).getByRole("alert")).toHaveTextContent("No se pudo cargar el resultado de tu caso.");
    set(null);
    const retry = within(block).getByRole("button", { name: "Intentar de nuevo" });
    retry.focus();
    fireEvent.click(retry);
    expect(await within(block).findByText("Todavía no hay un resultado que mostrar para tu caso.")).toHaveAttribute("role", "status");
    expect(within(block).getByRole("heading", { name: "Cómo terminó tu caso" })).toHaveFocus();
  });

  it("keeps the outcome shown when the re-read after a projection refresh fails, and says it may be out of date", async () => {
    const { read, set } = switchableRead(outcome);
    const rendered = openCase(read);
    const block = await screen.findByRole("region", { name: TITLE });
    expect(within(block).getByText("Settled")).toBeInTheDocument();
    set(offline());
    rendered.rerender(view(read, "en", { ...item, updates: [] }));
    expect(await within(screen.getByRole("region", { name: TITLE })).findByRole("alert")).toHaveTextContent("The outcome could not be refreshed. What is shown may be out of date.");
    expect(screen.getByText("Settled")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("still shows nothing after a refusal for role or scope, also on a retry", async () => {
    openCase(vi.fn(async () => { throw refusal(); }));
    await screen.findByRole("dialog", { name: "Overtime rotation grievance" });
    await settle();
    expect(screen.queryByRole("region", { name: TITLE })).not.toBeInTheDocument();
    document.body.innerHTML = "";

    const { read, set } = switchableRead(offline());
    openCase(read);
    const retry = await screen.findByRole("button", { name: "Try again" });
    set(refusal());
    fireEvent.click(retry);
    await settle();
    expect(screen.queryByRole("region", { name: TITLE })).not.toBeInTheDocument();
  });

  it("leaves focus where the member moved it while the retry ran", async () => {
    const slow = held(outcome);
    const read = vi.fn().mockRejectedValueOnce(offline()).mockImplementation(slow.run);
    openCase(read);
    const block = await screen.findByRole("region", { name: TITLE });
    const retry = within(block).getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    const dialog = screen.getByRole("dialog", { name: "Overtime rotation grievance" });
    const elsewhere = within(dialog).getAllByRole("button").find((button) => button !== retry && !button.disabled);
    elsewhere.focus();
    await act(async () => { slow.release(); });
    expect(await within(block).findByText("Settled")).toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });

  // #9984: Try again still held focus when the read landed, but the
  // member moved before the commit; the heading does not take it back.
  it("leaves focus where the member moved it after the read landed and before the heading would take it", async () => {
    const slow = held(outcome);
    const read = vi.fn().mockRejectedValueOnce(offline()).mockImplementation(slow.run);
    openCase(read);
    const block = await screen.findByRole("region", { name: TITLE });
    const retry = within(block).getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    const dialog = screen.getByRole("dialog", { name: "Overtime rotation grievance" });
    const elsewhere = within(dialog).getAllByRole("button").find((button) => button !== retry && !button.disabled);
    await act(async () => {
      slow.release();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      expect(retry).toHaveFocus();
      elsewhere.focus();
    });
    expect(await within(block).findByText("Settled")).toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });

  // #9984: without a loader the section shows nothing, as before.
  it("shows nothing, and no Try again, when the loader goes away for the same resolved case", async () => {
    const rendered = openCase(vi.fn(async () => { throw offline(); }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    rendered.rerender(view(null, "en", { ...item, updates: [] }));
    await settle();
    expect(screen.queryByRole("region", { name: TITLE })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows nothing, and no Try again, when the case is reopened after a failed read", async () => {
    const read = vi.fn(async () => { throw offline(); });
    const rendered = openCase(read);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    rendered.rerender(view(read, "en", { ...item, status: "active", updates: [] }));
    await settle();
    expect(screen.queryByRole("region", { name: TITLE })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("replaces the alert with a loading line while a retry runs and inserts it again when the retry fails", async () => {
    const slow = held(offline());
    const read = vi.fn().mockRejectedValueOnce(offline()).mockImplementation(slow.run);
    openCase(read, "es");
    const block = await screen.findByRole("region", { name: "Cómo terminó tu caso" });
    const first = within(block).getByRole("alert");
    fireEvent.click(within(block).getByRole("button", { name: "Intentar de nuevo" }));
    expect(within(block).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(block).getByRole("status")).toHaveTextContent("Cargando el resultado de tu caso…");
    await act(async () => { slow.release(); });
    const again = await within(block).findByRole("alert");
    expect(again).toHaveTextContent("No se pudo cargar el resultado de tu caso.");
    expect(again).not.toBe(first);
  });

  it("lets Try again read after a projection refresh while a retry for the earlier projection is still running", async () => {
    const slow = held(outcome);
    const read = vi.fn().mockRejectedValueOnce(offline()).mockImplementationOnce(slow.run).mockRejectedValue(offline());
    const rendered = openCase(read);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    rendered.rerender(view(read, "en", { ...item, updates: [] }));
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry).not.toHaveAttribute("aria-disabled");
    fireEvent.click(retry);
    await settle();
    expect(read).toHaveBeenCalledTimes(4);
    await act(async () => { slow.release(); });
    await settle();
    expect(screen.queryByText("Settled")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).not.toHaveAttribute("aria-disabled");
  });
});
