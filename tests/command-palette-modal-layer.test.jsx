import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/CommandPalette.jsx";
import { DemoWelcome, GuidedTour, PreviewGuide } from "../src/components/FloatingControls.jsx";
import { Dialog } from "../src/components/Dialog.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { t as translate } from "../src/lib/i18n.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { TaskModal } from "../src/views/TaskModal.jsx";
import { TasksView } from "../src/views/TasksView.jsx";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { WorkstreamSettings } from "../src/views/WorkstreamSettings.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// A11Y-UG-COMMAND-PALETTE-DIALOG-LAYER-AND-KEY-SCOPE-20261013 (P10-03):
// the palette used to inert its own siblings and never join the shared modal
// layer map, so a Dialog opened first gave the palette inert/aria-hidden and
// the visible palette could not be used. App renders the palette as a sibling
// of the shell body that holds every Dialog; this fixture keeps that ancestry.

function isolated(element) {
  for (let node = element; node; node = node.parentElement) {
    if (node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

let openDialog = () => {};

// The palette fades its scrim for 200 ms before it unmounts, as the
// prototype's search does.
const paletteGone = () => waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());

function Shell({ initialDialog = false }) {
  const [dialogOpen, setDialogOpen] = useState(initialDialog);
  openDialog = () => setDialogOpen(true);
  return (
    <LanguageProvider lang="en">
      <div className="sg-app">
        <a className="skip-link" href="#main-content">Skip</a>
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
        <div className="sg-shell-body">
          <main id="main-content" tabIndex={-1}>Page</main>
          {dialogOpen && (
            <Dialog title="Edit case" onClose={() => setDialogOpen(false)}>
              <label>Case note<input /></label>
            </Dialog>
          )}
        </div>
      </div>
    </LanguageProvider>
  );
}

describe("command palette in the shared modal layer stack", () => {
  it("opens above a Dialog, isolates the Dialog, and restores its draft and focus on Escape", async () => {
    render(<Shell initialDialog />);
    const dialog = screen.getByRole("dialog", { name: "Edit case" });
    const field = screen.getByRole("textbox", { name: "Case note" });
    fireEvent.change(field, { target: { value: "Draft grievance note" } });
    field.focus();

    fireEvent.keyDown(field, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const combobox = screen.getByRole("combobox", { name: "Search commands" });
    await waitFor(() => expect(isolated(palette)).toBe(false));
    expect(isolated(dialog)).toBe(true);
    expect(combobox).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(combobox, { key: "Escape" });
    await paletteGone();
    expect(dialog).toBeInTheDocument();
    expect(dialog.closest(".sg-detail-layer")).not.toHaveAttribute("data-state", "closing");
    await waitFor(() => expect(field).toHaveFocus());
    expect(isolated(dialog)).toBe(false);
    expect(field).toHaveValue("Draft grievance note");
    // The Dialog still owns the page: the shell outside it stays isolated.
    expect(isolated(screen.getByText("Page"))).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("isolates the palette when a Dialog opens above it, and hands the page back when both close", async () => {
    render(<Shell />);
    const page = screen.getByText("Page");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    expect(isolated(page)).toBe(true);
    expect(isolated(palette)).toBe(false);

    act(() => openDialog());
    // findByRole only matches once the palette's live isolation has released
    // the shell branch that now holds the newer Dialog.
    const dialog = await screen.findByRole("dialog", { name: "Edit case" });
    await waitFor(() => expect(isolated(palette)).toBe(true));
    expect(isolated(dialog)).toBe(false);

    // The Dialog is the newer modal layer, so Escape closes it first.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.transitionEnd(dialog.closest(".sg-detail-layer"));
    expect(screen.queryByRole("dialog", { name: "Edit case" })).not.toBeInTheDocument();
    await waitFor(() => expect(isolated(palette)).toBe(false));

    fireEvent.keyDown(window, { key: "Escape" });
    await paletteGone();
    await waitFor(() => expect(isolated(page)).toBe(false));
    expect(document.body.style.overflow).toBe("");
  });

  it("claims Escape so a window listener that honors defaultPrevented (TaskModal) keeps its surface open", async () => {
    // TaskModal installs its window Escape listener before the palette opens
    // and skips a press that is already prevented.
    const legacyClose = vi.fn();
    const legacy = (event) => { if (event.key === "Escape" && !event.defaultPrevented) legacyClose(); };
    window.addEventListener("keydown", legacy);
    try {
      render(<Shell initialDialog />);
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      await paletteGone();
      expect(legacyClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", legacy);
    }
  });

  it("leaves Escape to the shared layer stack instead of closing from the palette's own key handler", () => {
    // A real browser commits React state between the palette's handler and the
    // window listener, which jsdom's synchronous dispatch never does. Stopping
    // the press before window proves the palette has no second Escape path that
    // could close it ahead of the stack and expose the Dialog to the same press.
    const stop = (event) => event.stopPropagation();
    document.addEventListener("keydown", stop);
    try {
      render(<Shell initialDialog />);
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      expect(screen.getByRole("dialog", { name: "Command palette", hidden: true })).toBeInTheDocument();
    } finally {
      document.removeEventListener("keydown", stop);
    }
  });

  it("one palette Escape leaves the workstream settings sheet beneath it open", async () => {
    const settingsClose = vi.fn();
    render(
      <LanguageProvider lang="en">
        <WorkstreamSettings
          t={(key, params) => translate("en", key, params)}
          workstreams={[]}
          tasks={[]}
          onClose={settingsClose}
          onRename={vi.fn()}
          onPreviewMerge={vi.fn()}
          onMerge={vi.fn()}
        />
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(await screen.findByRole("combobox"), { key: "Escape" });
    await paletteGone();
    expect(document.querySelector('.sg-detail-layer[data-state="closing"]')).toBeNull();
    expect(settingsClose).not.toHaveBeenCalled();
  });

  it("one palette Escape leaves the task delete confirmation beneath it open", async () => {
    render(
      <LanguageProvider lang="en">
        <TasksView
          data={structuredClone(fallbackData)}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          onCreateTask={vi.fn()}
          onUpdateTask={vi.fn(async (_id, fields) => fields)}
          onDeleteTask={vi.fn()}
          onSendTaskMessage={vi.fn()}
        />
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Translate bargaining pulse" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    const confirm = screen.getByRole("alertdialog");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(await screen.findByRole("combobox"), { key: "Escape" });
    await paletteGone();
    expect(confirm).toBeInTheDocument();
    expect(confirm.closest(".task-editor-backdrop")).not.toHaveAttribute("data-state", "closing");
  });

  it("hides an isolated palette so it never paints over the newer modal", () => {
    // jsdom applies no stylesheet. The palette paints above every modal it can
    // open over (the live-poll projector is the highest at 1000), so when a
    // newer modal isolates it the inert palette must not stay visible.
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(/^\.command-palette__backdrop\[inert\]\s*\{\s*visibility:\s*hidden;\s*\}/m);
    const zIndex = (source, selector) => Number(source.match(new RegExp(`^\\${selector}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "m"))?.[1]);
    const projector = readFileSync(resolve(process.cwd(), "src/features/engagement/engagement.css"), "utf8");
    const projectorZ = Math.max(...[...projector.matchAll(/z-index:\s*(\d+)/g)].map((match) => Number(match[1])));
    expect(zIndex(css, ".command-palette__backdrop")).toBeGreaterThan(projectorZ);
    expect(zIndex(css, ".command-palette__backdrop")).toBeGreaterThan(zIndex(css, ".dialog-backdrop"));
  });

  it("one palette Escape leaves the live-poll projector beneath it open", async () => {
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({
      presence: { online: 1 }, delivery: {}, members: [], surveys: [],
      livePolls: [{ id: "poll", title: "Poll", state: "draft", voteCount: 0, results: [], attendance: {} }],
      pulsePrompts: [], channels: [],
    });
    render(
      <LanguageProvider lang="en">
        <StaffEngagement client={{ channel: vi.fn(), removeChannel: vi.fn() }} session={{ access_token: "token" }} />
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    fireEvent.click(screen.getByRole("button", { name: "Projector view" }));
    const projector = document.querySelector("[role='dialog']");
    expect(projector).not.toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(await screen.findByRole("combobox"), { key: "Escape" });
    await paletteGone();
    expect(projector).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("lets Tab reach Try again when the palette opens above the Tasks shortcuts sheet", async () => {
    window.history.replaceState({}, "", "/m/tasks");
    render(
      <LanguageProvider lang="en">
        <TasksView
          data={structuredClone(fallbackData)}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          onCreateTask={vi.fn()}
          onUpdateTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onSendTaskMessage={vi.fn()}
        />
        <CommandPalette commands={[]} onOpen={vi.fn(async () => { throw new Error("offline"); })} />
      </LanguageProvider>,
    );
    // Bare ? is opt-in (WCAG 2.1.4); the help button in Board view settings always opens the sheet.
    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const combobox = await screen.findByRole("combobox");
    await screen.findByRole("button", { name: "Try again" });
    // The palette leaves this Tab to the browser (Try again is the next stop);
    // the sheet beneath must not cancel it and pull focus back into itself.
    expect(fireEvent.keyDown(combobox, { key: "Tab" })).toBe(true);
    expect(combobox).toHaveFocus();
  });
  it("lets Tab reach Try again when the palette opens above a delete-locked task", async () => {
    const data = structuredClone(fallbackData);
    const task = data.tasks.find((item) => item.id === "task-demo-3");
    function LockedTask() {
      const { lang, t } = useLang();
      return (
        <TaskModal
          task={task}
          chapterId={data.member.chapterId}
          assignees={data.taskAssignees}
          documents={data.product.documents}
          workstreamNames={[]}
          memberId={data.member.id}
          messages={[]}
          comments={[]}
          attachments={[]}
          activity={[]}
          onClose={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          deleteBusy
          t={t}
          lang={lang}
        />
      );
    }
    render(
      <LanguageProvider lang="en">
        <LockedTask />
        <CommandPalette commands={[]} onOpen={vi.fn(async () => { throw new Error("offline"); })} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const combobox = await screen.findByRole("combobox");
    await screen.findByRole("button", { name: "Try again" });
    // A delete-locked task swallows Tab on window; the palette's own Tab
    // must still reach the browser so focus can move to Try again.
    expect(fireEvent.keyDown(combobox, { key: "Tab" })).toBe(true);
  });

  it("hands a task returned above the palette its own focus and Escape, then gives the search back (G1-03, G1-04)", async () => {
    const data = structuredClone(fallbackData);
    const task = data.tasks.find((item) => item.id === "task-demo-3");
    const onClose = vi.fn();
    let setTaskOpen = () => {};
    let releasedAtFocus = null;
    function ReturnedTask() {
      const { lang, t } = useLang();
      return (
        <TaskModal
          task={task}
          chapterId={data.member.chapterId}
          assignees={data.taskAssignees}
          documents={data.product.documents}
          workstreamNames={[]}
          memberId={data.member.id}
          messages={[]}
          comments={[]}
          attachments={[]}
          activity={[]}
          onClose={onClose}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          t={t}
          lang={lang}
        />
      );
    }
    // Runs after TaskModal's own mount focus, in the same commit: a browser
    // refuses that focus if the task's branch is still inert at this point.
    function FocusProbe() {
      useEffect(() => {
        const dialog = document.querySelector(".kan-modal-backdrop");
        releasedAtFocus = dialog ? !isolated(dialog) : null;
      }, []);
      return null;
    }
    function TaskShell() {
      const [taskOpen, setOpen] = useState(false);
      setTaskOpen = setOpen;
      return (
        <LanguageProvider lang="en">
          <div className="sg-app">
            <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
            <div className="sg-shell-body">
              <main id="main-content" tabIndex={-1}>Page</main>
              {taskOpen && <><ReturnedTask /><FocusProbe /></>}
            </div>
          </div>
        </LanguageProvider>
      );
    }
    render(<TaskShell />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const combobox = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(combobox, { target: { value: "My" } });

    act(() => setTaskOpen(true));
    expect(releasedAtFocus).toBe(true);
    expect(isolated(palette)).toBe(true);

    const taskButton = document.querySelector(".kan-modal-backdrop button:not([disabled])");
    taskButton.focus();
    fireEvent.keyDown(taskButton, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Still mounted, only hidden from the accessibility tree beneath the task.
    expect(palette).toBeInTheDocument();
    expect(combobox).toHaveValue("My");

    act(() => setTaskOpen(false));
    document.activeElement?.blur();
    await waitFor(() => expect(isolated(palette)).toBe(false));
    await waitFor(() => expect(combobox).toHaveFocus());
    expect(combobox).toHaveValue("My");
  });

  it.each([
    ["the demo welcome", (onClose) => <DemoWelcome memberName="Maria" roleName="Steward" onExplore={onClose} />],
    ["the preview guide", (onClose) => <PreviewGuide onClose={onClose} onNavigate={vi.fn()} onStartTour={vi.fn()} />],
    ["the guided tour", (onClose) => <GuidedTour onClose={onClose} onNavigate={vi.fn()} />],
  ])("one palette Escape leaves %s beneath it open", async (_name, overlay) => {
    const onClose = vi.fn();
    render(
      <LanguageProvider lang="en">
        <div className="sg-app">
          <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
          <div className="sg-shell-body">{overlay(onClose)}</div>
        </div>
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const combobox = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.keyDown(combobox, { key: "Escape" });
    await paletteGone();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps a palette hidden beneath a newer Dialog, and its query, on Ctrl+K", async () => {
    render(<Shell />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const combobox = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(combobox, { target: { value: "My" } });
    act(() => openDialog());
    await waitFor(() => expect(isolated(palette)).toBe(true));

    expect(fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(false);
    expect(palette).toBeInTheDocument();
    expect(combobox).toHaveValue("My");
  });

  it("keeps focus in the palette when its text is clicked, so Escape stays the palette's above an unsaved sheet", async () => {
    const settingsClose = vi.fn();
    render(
      <LanguageProvider lang="en">
        <WorkstreamSettings
          t={(key, params) => translate("en", key, params)}
          workstreams={[]}
          tasks={[]}
          onClose={settingsClose}
          onRename={vi.fn()}
          onPreviewMerge={vi.fn()}
          onMerge={vi.fn()}
        />
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const combobox = await screen.findByRole("combobox");
    fireEvent.change(combobox, { target: { value: "zzz" } });
    const status = screen.getByRole("status");
    // A browser moves focus to body on mousedown over non-focusable text
    // unless the palette prevents it.
    expect(fireEvent.mouseDown(status)).toBe(false);
    expect(fireEvent.mouseDown(combobox)).toBe(true);

    // Focus that still falls to body comes back to the search.
    act(() => combobox.blur());
    expect(document.activeElement).toBe(document.body);
    await waitFor(() => expect(combobox).toHaveFocus());

    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    await paletteGone();
    expect(settingsClose).not.toHaveBeenCalled();
  });
});
