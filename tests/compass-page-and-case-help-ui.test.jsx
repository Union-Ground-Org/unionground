// REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001: the case card and the
// page-aware toggle.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { CompassCaseHelp } from "../src/features/compass/CompassCaseHelp.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

// #7462: the sources under an answer are a labelled list, one row per source
// (its title, then the article it cites).
const sourceRows = (label = "Sources") => within(screen.getByRole("list", { name: label })).getAllByRole("listitem")
  .map((item) => [...item.children].map((part) => part.textContent));

const CASE = "51002400-0000-4000-8000-000000000301";

describe("Ask Compass about this case", () => {
  it("asks one fixed question, shows the answer with its sources and says it is not saved", async () => {
    const ask = vi.fn().mockResolvedValue({ answer: "Your case is at Step 2.", sources: [{ id: "kb:1", title: "Grievance steps", ref: "Article 12" }] });
    render(<LanguageProvider lang="en"><CompassCaseHelp caseId={CASE} ask={ask} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: t("en", "compass.caseHelp.title") })).toBeInTheDocument();
    expect(screen.getByText(t("en", "compass.caseHelp.notice"))).toBeInTheDocument();
    const group = screen.getByRole("group", { name: t("en", "compass.caseHelp.questionsLabel") });
    expect(group.querySelectorAll("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.caseHelp.q.prepare") }));
    expect(ask).toHaveBeenCalledWith(CASE, "prepare");
    expect(await screen.findByText("Your case is at Step 2.")).toBeInTheDocument();
    expect(sourceRows()).toEqual([["Grievance steps", "Article 12"]]);
    expect(screen.getByText(t("en", "compass.caseHelp.notSaved"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("en", "compass.caseHelp.q.prepare") })).toHaveAttribute("aria-pressed", "true");
  });

  it("explains a switched-off organization in the reader's language and discloses narrative use", async () => {
    const ask = vi.fn().mockRejectedValue(Object.assign(new Error("off"), { code: "feature_disabled" }));
    render(<LanguageProvider lang="es"><CompassCaseHelp caseId={CASE} ask={ask} includesNarrative /></LanguageProvider>);
    expect(screen.getByText(t("es", "compass.caseHelp.noticeNarrative"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("es", "compass.caseHelp.q.next") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("es", "compass.caseHelp.off"));
  });
});

describe("case help refusals", () => {
  it.each([
    ["case_unavailable", "compass.caseHelp.unavailable"],
    ["compass_paused", "compass.pausedNotice"],
    [undefined, "compass.caseHelp.failed"],
  ])("explains %s", async (code, key) => {
    const ask = vi.fn().mockRejectedValue(Object.assign(new Error("x"), code ? { code } : {}));
    render(<LanguageProvider lang="en"><CompassCaseHelp caseId={CASE} ask={ask} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.caseHelp.q.rights") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", key));
  });

  it("lets the member cancel keeping the answer as a case note, and says so when saving fails", async () => {
    const ask = vi.fn().mockResolvedValue({ answer: "Step 2 next.", sources: [{ id: "kb:3", title: "Grievance steps", ref: "County CBA 2025-2028 · Article 14" }] });
    const onAddNote = vi.fn().mockRejectedValue(new Error("offline"));
    render(<LanguageProvider lang="en"><CompassCaseHelp caseId={CASE} ask={ask} onAddNote={onAddNote} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.caseHelp.q.next") }));
    expect(await screen.findByText("Step 2 next.")).toBeInTheDocument();
    expect(sourceRows()).toEqual([["Grievance steps", "Article 14"]]);
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.actions.addCaseNote") }));
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.actions.cancel") }));
    expect(screen.queryByRole("button", { name: t("en", "compass.actions.caseNoteConfirm") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.actions.addCaseNote") }));
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.actions.caseNoteConfirm") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "compass.actions.failed"));
    expect(onAddNote).toHaveBeenCalledWith(CASE, "Step 2 next.");
  });

  it("names a source by its title when it has no reference and ignores a busy second press", async () => {
    let resolve;
    const ask = vi.fn(() => new Promise((done) => { resolve = done; }));
    render(<LanguageProvider lang="en"><CompassCaseHelp caseId={CASE} ask={ask} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.caseHelp.q.next") }));
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.caseHelp.q.prepare") }));
    expect(ask).toHaveBeenCalledTimes(1);
    resolve({ answer: "Step 2 next.", sources: [{ id: "kb:2", title: "Steps guide", ref: "" }] });
    expect(await screen.findByRole("list", { name: t("en", "compass.sourcesLabel") })).toBeInTheDocument();
    expect(sourceRows()).toEqual([["Steps guide"]]);
  });
});

describe("Compass page-aware toggle", () => {
  it("sends the page key while on, nothing when turned off, and hides behind figures mode", async () => {
    const onSend = vi.fn().mockResolvedValue(null);
    render(<LanguageProvider lang="en"><Assistant threads={[]} onClose={vi.fn()} onSend={onSend} pageHelp={{ key: "rights", label: "Know your rights" }} staffDataAvailable /></LanguageProvider>);
    const toggle = screen.getByRole("button", { name: t("en", "compass.page.toggle", { page: "Know your rights" }) });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const input = screen.getByRole("textbox", { name: t("en", "compass.askAria") });
    fireEvent.change(input, { target: { value: "How do I file a grievance?" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "guide.send") }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("How do I file a grievance?", null, [], { page: "rights" }));
    fireEvent.click(toggle);
    fireEvent.change(input, { target: { value: "How do I file a grievance?" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "guide.send") }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("How do I file a grievance?", null, [], undefined));
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.numbers.toggle") }));
    expect(screen.queryByRole("button", { name: t("en", "compass.page.toggle", { page: "Know your rights" }) })).toBeNull();
  });

  it("is absent without page help", () => {
    render(<LanguageProvider lang="en"><Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn()} /></LanguageProvider>);
    expect(screen.queryByRole("group", { name: t("en", "compass.numbers.groupLabel") })).toBeNull();
  });
});

// Keeping the answer as a case note keeps focus while it saves, and
// a second confirmation in the same tick writes no second note to the case.
describe("Compass case help while a case note is saved", () => {
  const toConfirm = async (onAddNote) => {
    const ask = vi.fn().mockResolvedValue({ answer: "Step 2 next.", sources: [] });
    render(<LanguageProvider lang="en"><CompassCaseHelp caseId={CASE} ask={ask} onAddNote={onAddNote} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.caseHelp.q.next") }));
    await screen.findByText("Step 2 next.");
    fireEvent.click(screen.getByRole("button", { name: t("en", "compass.actions.addCaseNote") }));
    return screen.getByRole("button", { name: t("en", "compass.actions.caseNoteConfirm") });
  };

  it("keeps the case-note confirm focused while the note is saved, and saves once", async () => {
    const onAddNote = vi.fn(async () => undefined);
    await expectHeldWriteFocus(onAddNote, await toConfirm(onAddNote));
    expect(onAddNote).toHaveBeenCalledExactlyOnceWith(CASE, "Step 2 next.");
  });

  it("saves one case note when the confirm is activated twice in one tick", async () => {
    const onAddNote = vi.fn(async () => undefined);
    const confirm = await toConfirm(onAddNote);
    await expectOneWriteFromOneTick(onAddNote, [() => fireEvent.click(confirm), () => fireEvent.click(confirm)]);
  });
});
