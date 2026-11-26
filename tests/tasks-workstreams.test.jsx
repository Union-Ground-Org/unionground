import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { TasksView } from "../src/views/TasksView.jsx";
import { WorkstreamSettings } from "../src/views/WorkstreamSettings.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

// Two layers, one feature.
//
// The panel (second half of this file) is unchanged by the t0ggles rebuild and
// keeps its own pins: rename is unremarkable; the merge admits what it costs. A
// rename collision (23505) surfaces as the merge OFFER, the dialog is built from
// the server preview (never a client count), the finished count is stated
// separately, direction is named in both buttons, the safe path is a decision,
// "cannot be undone" is said once, and a stale preview (40001) re-reads.
//
// What DID change is how anyone reaches it. Workstreams used to be a control on
// the old board chrome; the rebuild made them the board's COLUMNS. The
// duplicate header strips and the per-column kebab are gone (2026-08-03). The
// maintenance panel now hangs off one staff-toolbar control, gated on a staff
// role AND a parent that passed the rename write. A role gate that renders the
// control anyway is the failure nobody catches by reading the panel: the panel
// is fine, it is the door that was left open. So the first half of this file
// renders the real screen and checks who is offered that door.
//
// The third piece is the empty board. A chapter created after the seed has zero
// workstreams, which means zero columns, which means zero inline composers —
// the board has no create surface at all until someone names the first
// workstream. Staff get that one inline; everyone else gets the plain CTA,
// because free-text workstreams from members would fail the migration's
// workstream assert anyway.

const t = (key, vars) => translate("en", key, vars);

function renderTasks(overrides = {}) {
  const props = {
    data: structuredClone(fallbackData),
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task" })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    onAddWorkstream: vi.fn(async () => ({ id: "w-new", name: "Housing" })),
    onRenameWorkstream: vi.fn(async () => ({ id: "w-1", name: "renamed", movedTasks: 0 })),
    onPreviewMergeWorkstreams: vi.fn(async () => null),
    onMergeWorkstreams: vi.fn(async () => null),
    ...overrides,
  };
  render(<LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>);
  return props;
}

function staffData() {
  const data = structuredClone(fallbackData);
  data.roles = ["coordinator"];
  return data;
}

function emptyBoard(data) {
  const next = structuredClone(data);
  next.tasks = [];
  next.workstreams = [];
  return next;
}

describe("the two doors into workstream maintenance", () => {
  it("removes the duplicate desktop Workstreams header button", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });
    renderTasks({ data: staffData() });
    window.matchMedia = realMatchMedia;
    expect(document.querySelector(".phead .wtk-actions")).toBeNull();
    expect(within(document.querySelector(".phead")).queryByRole("button", { name: "Workstreams" })).not.toBeInTheDocument();
    expect(within(document.querySelector(".phead")).queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });

  it("removes the duplicate Done, Workstreams and New task strip from the mobile header", () => {
    renderTasks({ data: staffData() });
    const header = document.querySelector(".tasks-screen .phead");
    expect(header).not.toBeNull();
    expect(header.querySelector(".wtk-actions")).toBeNull();
    expect(within(header).queryByRole("button", { name: "Workstreams" })).not.toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(header.querySelector(".wtk-donechip")).toBeNull();
  });

  it("omits workstream menus from staff lane headers", () => {
    renderTasks({ data: staffData() });
    expect(document.querySelectorAll(".kan-ws-head__menu")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Workstreams — / })).not.toBeInTheDocument();
  });

  it("opens the Workstreams panel from the staff toolbar and restores focus on close", async () => {
    renderTasks({ data: staffData(), staffAccess: true });
    const toolbar = document.querySelector(".kan-topbar");
    expect(toolbar).not.toBeNull();
    const trigger = within(toolbar).getByRole("button", { name: t("tasks.workstreams") });
    expect(document.querySelector(".phead")).not.toContainElement(trigger);
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: t("tasks.workstreams") });
    expect(dialog).toHaveAttribute("aria-labelledby", "workstream-panel-title");
    expect(dialog).toContainElement(document.activeElement);

    fireEvent.click(screen.getByRole("button", { name: t("tasks.close") }));
    await waitFor(() => {
      expect(document.querySelector(".workstream-panel")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("offers neither door to a member without a staff role", () => {
    renderTasks();
    const toolbar = document.querySelector(".kan-topbar");
    expect(toolbar).not.toBeNull();
    expect(within(toolbar).queryByRole("button", { name: t("tasks.workstreams") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workstreams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Workstreams — / })).not.toBeInTheDocument();
    // The board still renders — columns are not a staff feature, maintaining
    // them is.
    expect(document.querySelectorAll(".kan-col").length).toBeGreaterThan(0);
  });

  // Capability is two answers, not one: the role AND a parent that actually
  // passed the write. A demo or a partially wired parent gets no dead control.
  it("offers neither door when the parent passed no rename handler", () => {
    renderTasks({ data: staffData(), onRenameWorkstream: null });
    const toolbar = document.querySelector(".kan-topbar");
    expect(toolbar).not.toBeNull();
    expect(within(toolbar).queryByRole("button", { name: t("tasks.workstreams") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workstreams" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Workstreams — / })).not.toBeInTheDocument();
  });
});

describe("a board with no workstreams yet", () => {
  it("lets staff name the first one inline", async () => {
    const props = renderTasks({ data: emptyBoard(staffData()) });
    expect(screen.getByText("Nothing is assigned to you yet.")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save name" });
    // Nothing typed is not a workstream: the save cannot fire on an empty name.
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Workstream name"), { target: { value: "  Housing  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(props.onAddWorkstream).toHaveBeenCalledWith("Housing"));
  });

  it("keeps Save name focused while the first workstream is created (#8435)", async () => {
    const props = renderTasks({ data: emptyBoard(staffData()) });
    fireEvent.change(screen.getByLabelText("Workstream name"), { target: { value: "Housing" } });
    await expectHeldWriteFocus(props.onAddWorkstream, screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(props.onAddWorkstream).toHaveBeenCalledTimes(1));
  });

  it("says the name is taken instead of a generic save error", async () => {
    const collision = new Error("that name is already in use in this chapter");
    collision.code = "23505";
    renderTasks({
      data: emptyBoard(staffData()),
      onAddWorkstream: vi.fn(async () => { throw collision; }),
    });
    fireEvent.change(screen.getByLabelText("Workstream name"), { target: { value: "Housing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByRole("alert")).toHaveTextContent('"Housing" already exists.');
  });

  it("gives a member the composer CTA and no name field", () => {
    renderTasks({ data: emptyBoard(fallbackData) });
    const empty = document.querySelector(".tasks-empty");
    expect(within(empty).getByRole("button", { name: t("tasks.new") })).toBeInTheDocument();
    // Free text for members stays impossible on purpose: after the migration
    // the workstream assert rejects unknown names anyway.
    expect(screen.queryByLabelText("Workstream name")).not.toBeInTheDocument();
    expect(document.querySelector(".kan-firstws")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The panel itself, rendered directly — unchanged by the rebuild.
// ---------------------------------------------------------------------------

const ENTITIES = [
  { id: "w-events", name: "Events" },
  { id: "w-evnts", name: "Evnts" },
  { id: "w-empty", name: "Empty" },
];

const TASKS = [
  ...Array.from({ length: 14 }, (_, index) => ({ id: `s${index}`, workstream: "Evnts", status: index < 9 ? "done" : "backlog" })),
  ...Array.from({ length: 27 }, (_, index) => ({ id: `t${index}`, workstream: "Events", status: "backlog" })),
];

const PREVIEW = {
  sourceName: "Evnts",
  targetName: "Events",
  movingTasks: 14,
  movingDoneTasks: 9,
  targetExistingTasks: 27,
};

function collision() {
  const error = new Error("Rename workstream: that name is already in use in this chapter");
  error.code = "23505";
  return error;
}

function renderPanel(overrides = {}) {
  const props = {
    t,
    workstreams: structuredClone(ENTITIES),
    tasks: structuredClone(TASKS),
    onClose: vi.fn(),
    onRename: vi.fn(async () => ({ id: "w-evnts", name: "renamed", movedTasks: 14 })),
    onPreviewMerge: vi.fn(async () => structuredClone(PREVIEW)),
    onMerge: vi.fn(async () => ({ targetId: "w-events", targetName: "Events", removedName: "Evnts", movedTasks: 14 })),
    ...overrides,
  };
  render(<WorkstreamSettings {...props} />);
  return props;
}

async function renameEvntsTo(name) {
  fireEvent.click(screen.getByRole("button", { name: "Rename Evnts" }));
  fireEvent.change(screen.getByLabelText("Workstream name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
}

describe("rename", () => {
  it("keeps Save name focused while the rename is saved, and renames once (record 8435)", async () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Rename Evnts" }));
    fireEvent.change(screen.getByLabelText("Workstream name"), { target: { value: "Event planning" } });
    await expectHeldWriteFocus(props.onRename, screen.getByRole("button", { name: "Save name" }));
    expect(props.onRename).toHaveBeenCalledTimes(1);
  });

  it("lists each workstream with its live board count and renames in place", async () => {
    const props = renderPanel();
    expect(screen.getByText("Events").closest(".workstream-row")).toHaveTextContent("27 tasks");
    expect(screen.getByText("Evnts").closest(".workstream-row")).toHaveTextContent("14 tasks");
    expect(screen.getByText("Empty").closest(".workstream-row")).toHaveTextContent("0 tasks");

    await renameEvntsTo("Event planning");
    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith("w-evnts", "Event planning"));
  });

  it("surfaces a collision as the merge offer, not an error", async () => {
    const props = renderPanel({ onRename: vi.fn(async () => { throw collision(); }) });
    await renameEvntsTo("Events");

    // The offer states what exists, what would move, and offers the review.
    expect(await screen.findByText('"Events" already exists.')).toBeInTheDocument();
    expect(screen.getByText(/would move 14 tasks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review the merge" })).toBeInTheDocument();
    // Built from the server preview, never from a client-side count.
    expect(props.onPreviewMerge).toHaveBeenCalledWith("w-evnts", "w-events");
  });
});

describe("the merge dialog", () => {
  async function openMergeDialog(props) {
    await renameEvntsTo("Events");
    fireEvent.click(await screen.findByRole("button", { name: "Review the merge" }));
    await waitFor(() => expect(props.onPreviewMerge).toHaveBeenCalledTimes(2));
  }

  // A pending control stays focusable and refuses a second write.
  it("keeps Merge into Events focused while the merge runs, and merges once", async () => {
    const props = renderPanel({ onRename: vi.fn(async () => { throw collision(); }) });
    await openMergeDialog(props);
    await expectHeldWriteFocus(props.onMerge, screen.getByRole("button", { name: "Merge into Events" }));
    await waitFor(() => expect(props.onMerge).toHaveBeenCalledTimes(1));
  });

  it("states the irreversible part, names direction in both buttons, safe path first", async () => {
    const props = renderPanel({ onRename: vi.fn(async () => { throw collision(); }) });
    await openMergeDialog(props);

    expect(screen.getByText('Merge "Evnts" into "Events"?')).toBeInTheDocument();
    expect(screen.getByText(/14 tasks move to Events/)).toBeInTheDocument();
    // The finished count is called out separately — it rewrites history.
    expect(screen.getByText(/9 of them are finished/)).toBeInTheDocument();
    expect(screen.getByText("Events currently has 27 tasks.")).toBeInTheDocument();
    // Said once, and meant.
    expect(screen.getAllByText("This cannot be undone.")).toHaveLength(1);

    const footer = document.querySelector(".workstream-merge footer");
    const buttons = within(footer).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Keep them separate");
    expect(buttons[1]).toHaveTextContent("Merge into Events");

    // Keeping them separate is a decision, not a cancel-shaped merge.
    fireEvent.click(buttons[0]);
    expect(props.onMerge).not.toHaveBeenCalled();
    expect(screen.queryByText('Merge "Evnts" into "Events"?')).not.toBeInTheDocument();
  });

  it("passes the preview's count back as optimistic concurrency", async () => {
    const props = renderPanel({ onRename: vi.fn(async () => { throw collision(); }) });
    await openMergeDialog(props);
    fireEvent.click(screen.getByRole("button", { name: "Merge into Events" }));
    await waitFor(() => expect(props.onMerge).toHaveBeenCalledWith("w-evnts", "w-events", 14));
  });

  it("re-reads a stale preview (PT409) instead of widening the merge", async () => {
    const stale = new Error("Merge workstreams: this workstream changed while you were looking at it");
    stale.code = "PT409";
    const props = renderPanel({
      onRename: vi.fn(async () => { throw collision(); }),
      onMerge: vi.fn()
        .mockRejectedValueOnce(stale)
        .mockRejectedValueOnce(new Error("nope")),
    });
    await openMergeDialog(props);
    fireEvent.click(screen.getByRole("button", { name: "Merge into Events" }));

    expect(await screen.findByText("This changed while you were looking at it. Review the merge again.")).toBeInTheDocument();
    // The dialog re-read the preview rather than trusting the one on screen.
    expect(props.onPreviewMerge).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Merge "Evnts" into "Events"?')).toBeInTheDocument();
    // The stale-preview copy is the only alert — do not also paint the merge failure.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(t("tasks.errorMerge"))).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Merge into Events" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("tasks.errorMerge"));
    expect(screen.getByText('Merge "Evnts" into "Events"?')).toBeInTheDocument();
    expect(screen.queryByText(t("tasks.mergeStale"))).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Merge into Events" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Keep them separate" })).toBeEnabled();
  });

  it("keeps the merge view open with an alert when confirm rejects", async () => {
    let releaseRetry;
    const props = renderPanel({
      onRename: vi.fn(async () => { throw collision(); }),
      onMerge: vi.fn()
        .mockRejectedValueOnce(new Error("nope"))
        .mockImplementationOnce(() => new Promise((resolve) => { releaseRetry = resolve; })),
    });
    await openMergeDialog(props);
    fireEvent.click(screen.getByRole("button", { name: "Merge into Events" }));

    expect(await screen.findByText('Merge "Evnts" into "Events"?')).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(t("tasks.errorMerge"));
    expect(screen.getByRole("button", { name: "Merge into Events" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Keep them separate" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Merge into Events" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(screen.getByText('Merge "Evnts" into "Events"?')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge into Events" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Keep them separate" })).toHaveAttribute("aria-disabled", "true");
    // ...and both refuse a click while the retry runs.
    fireEvent.click(screen.getByRole("button", { name: "Merge into Events" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep them separate" }));
    expect(props.onMerge).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Merge "Evnts" into "Events"?')).toBeInTheDocument();
    releaseRetry({ targetId: "w-events", targetName: "Events", removedName: "Evnts", movedTasks: 14 });
    await waitFor(() => {
      expect(screen.queryByText('Merge "Evnts" into "Events"?')).not.toBeInTheDocument();
    });
  });
});

// Every failure the panel paints comes out of the same alert line, so the copy
// is the only thing that tells a steward WHICH action died. Rename, merge and
// removal are three different recoveries; three different sentences.
describe("the failure each action reports", () => {
  it("still says the rename failed when the rename itself fails", async () => {
    renderPanel({ onRename: vi.fn(async () => { throw new Error("nope"); }) });
    await renameEvntsTo("Event planning");

    expect(await screen.findByRole("alert")).toHaveTextContent(t("tasks.errorRename"));
  });

  it("says the merge failed when the collision's preview cannot be read", async () => {
    const props = renderPanel({
      onRename: vi.fn(async () => { throw collision(); }),
      onPreviewMerge: vi.fn(async () => { throw new Error("nope"); }),
    });
    await renameEvntsTo("Events");

    // The rename is finished — the name exists. What the steward is now being
    // offered, and what failed, is the merge.
    expect(await screen.findByRole("alert")).toHaveTextContent(t("tasks.errorMerge"));
    expect(screen.queryByText(t("tasks.errorRename"))).not.toBeInTheDocument();
    expect(props.onPreviewMerge).toHaveBeenCalledWith("w-evnts", "w-events");
  });

  it("says the merge failed when opening the merge dialog cannot re-read the preview", async () => {
    const props = renderPanel({
      onRename: vi.fn(async () => { throw collision(); }),
      onPreviewMerge: vi.fn()
        .mockImplementationOnce(async () => structuredClone(PREVIEW))
        .mockImplementationOnce(async () => { throw new Error("nope"); }),
    });
    await renameEvntsTo("Events");
    fireEvent.click(await screen.findByRole("button", { name: "Review the merge" }));
    await waitFor(() => expect(props.onPreviewMerge).toHaveBeenCalledTimes(2));

    // The offer stays on screen and carries its own alert role, so name the
    // failure line itself rather than "the" alert.
    expect(await screen.findByText(t("tasks.errorMerge"))).toHaveAttribute("role", "alert");
    expect(screen.queryByText(t("tasks.errorRename"))).not.toBeInTheDocument();
  });

  it("says the removal failed when the zero-move merge behind Remove fails", async () => {
    renderPanel({ onMerge: vi.fn(async () => { throw new Error("nope"); }) });
    const row = screen.getByText("Empty").closest(".workstream-row");
    fireEvent.click(within(row).getByRole("button", { name: "Remove Empty" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The server path is a merge; the steward asked to remove. The copy
    // follows the steward, and is neither the rename nor the merge sentence.
    expect(await screen.findByRole("alert")).toHaveTextContent(t("tasks.errorRemove"));
    expect(screen.queryByText(t("tasks.errorRename"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("tasks.errorMerge"))).not.toBeInTheDocument();
  });

  it("gives rename, merge and removal three distinct sentences in both catalogues", () => {
    for (const lang of ["en", "es"]) {
      const keys = ["tasks.errorRename", "tasks.errorMerge", "tasks.errorRemove"];
      const said = keys.map((key) => translate(lang, key));
      expect(said.every((line) => typeof line === "string" && line.length > 0)).toBe(true);
      expect(new Set(said).size).toBe(3);
      // Spanish must be translated, not the English line served as a fallback.
      if (lang === "es") keys.forEach((key, i) => expect(said[i]).not.toBe(translate("en", key)));
    }
  });
});

describe("edge states", () => {
  it("offers Remove, not merge, for a workstream with nothing on the board", async () => {
    const props = renderPanel();
    const row = screen.getByText("Empty").closest(".workstream-row");
    fireEvent.click(within(row).getByRole("button", { name: "Remove Empty" }));
    expect(screen.getByText('Nothing on the board uses "Empty". Removing it moves no tasks.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    // Removal is the merge that moves nothing — previewed and counted the
    // same way, with an expected count of zero.
    await waitFor(() => expect(props.onMerge).toHaveBeenCalledWith("w-empty", "w-events", 0));
  });

  it("keeps the last workstream un-mergeable — every card must name one", () => {
    renderPanel({ workstreams: [{ id: "w-events", name: "Events" }], tasks: [] });
    expect(screen.getByText("A campaign needs at least one workstream.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });
});

describe("row action names", () => {
  // A row action that only ever says "Remove" reads as one of N identical
  // buttons in a screen reader's element list: the name has to carry the
  // workstream it acts on. The visible word stays inside the spoken name so
  // speech input still reaches it (WCAG 2.5.3).
  it("names the workstream in every rename and remove trigger", () => {
    renderPanel({ tasks: [] });

    const names = [...document.querySelectorAll(".workstream-row__actions button")]
      .map((button) => button.getAttribute("aria-label") || button.textContent);
    expect(names).toHaveLength(ENTITIES.length * 2);
    expect(new Set(names).size).toBe(names.length);

    for (const entity of ENTITIES) {
      expect(screen.getByRole("button", { name: `Rename ${entity.name}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Remove ${entity.name}` })).toHaveTextContent(t("tasks.workstreamRemove"));
    }
  });

  it("keeps the confirm dialog's Remove button undisambiguated — its body already names the workstream", () => {
    renderPanel();
    const row = screen.getByText("Empty").closest(".workstream-row");
    fireEvent.click(within(row).getByRole("button", { name: "Remove Empty" }));
    expect(screen.getByRole("button", { name: t("tasks.workstreamRemove") })).toBeInTheDocument();
  });

  it("keeps the visible label inside the Spanish name too", () => {
    expect(translate("es", "tasks.workstreamRemoveAction", { name: "Vivienda" }))
      .toContain(translate("es", "tasks.workstreamRemove"));
  });
});

describe("panel keyboard focus", () => {
  function dialogNode() {
    return document.querySelector("[role=dialog]");
  }

  function expectFocusInsideDialog() {
    const dialog = dialogNode();
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(document.querySelector(".task-editor-backdrop"));
    expect(document.activeElement.getAttribute("aria-hidden")).not.toBe("true");
  }

  it("places focus inside the dialog on a perceivable target when it opens", () => {
    renderPanel();
    expectFocusInsideDialog();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Workstreams" }));
  });

  it("returns focus to the row rename trigger after a merge keep", async () => {
    const props = renderPanel({ onRename: vi.fn(async () => { throw collision(); }) });
    await renameEvntsTo("Events");
    fireEvent.click(await screen.findByRole("button", { name: "Review the merge" }));
    await waitFor(() => expect(props.onPreviewMerge).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Keep them separate" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Keep them separate" }));
    expectFocusInsideDialog();
    expect(screen.getByRole("button", { name: "Rename Evnts" })).toHaveFocus();
  });

  it("returns focus to the row remove trigger after a removal keep", () => {
    renderPanel();
    const row = screen.getByText("Empty").closest(".workstream-row");
    fireEvent.click(within(row).getByRole("button", { name: "Remove Empty" }));
    expect(screen.getByRole("button", { name: "Keep them separate" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Keep them separate" }));
    expectFocusInsideDialog();
    expect(within(screen.getByText("Empty").closest(".workstream-row")).getByRole("button", { name: "Remove Empty" })).toHaveFocus();
  });

  it("restores to the heading after a merge succeeds, not the row about to vanish", async () => {
    const props = renderPanel({ onRename: vi.fn(async () => { throw collision(); }) });
    await renameEvntsTo("Events");
    fireEvent.click(await screen.findByRole("button", { name: "Review the merge" }));
    await waitFor(() => expect(props.onPreviewMerge).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Merge into Events" }));
    await waitFor(() => expect(props.onMerge).toHaveBeenCalledWith("w-evnts", "w-events", 14));
    // The parent has not reconciled yet, so the merged-away row is still on
    // screen. Focus must not land on it — it disappears on the refresh.
    expect(screen.getByRole("button", { name: "Rename Evnts" })).toBeInTheDocument();
    expectFocusInsideDialog();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Workstreams" }));
  });

  function withEmbedUrl(run, { framed }) {
    const search = window.location.search;
    const parent = Object.getOwnPropertyDescriptor(window, "parent");
    window.history.replaceState({}, "", "/?embed=phone");
    if (framed) Object.defineProperty(window, "parent", { value: {}, configurable: true });
    try {
      run();
    } finally {
      if (framed) {
        if (parent) Object.defineProperty(window, "parent", parent);
        else delete window.parent;
      }
      window.history.replaceState({}, "", search || "/");
    }
  }

  it("leaves focus alone in the mirrored companion-phone embed", () => {
    withEmbedUrl(() => {
      renderPanel();
      expect(dialogNode()).not.toBeNull();
      expect(dialogNode().contains(document.activeElement)).toBe(false);
    }, { framed: true });
  });

  it("still focuses the dialog when an embed URL is opened top-level", () => {
    // A shared ?embed=phone link in its own tab is the ordinary shell, not a
    // mirror — nothing else holds focus, so the dialog must take it.
    withEmbedUrl(() => {
      expect(window.parent).toBe(window);
      renderPanel();
      expectFocusInsideDialog();
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Workstreams" }));
    }, { framed: false });
  });

  it("returns focus to the row rename trigger after a rename cancel", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Rename Evnts" }));
    expect(screen.getByLabelText("Workstream name")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expectFocusInsideDialog();
    expect(screen.getByRole("button", { name: "Rename Evnts" })).toHaveFocus();
  });
});
