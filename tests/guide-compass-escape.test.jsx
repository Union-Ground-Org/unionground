import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { CommandPalette } from "../src/components/CommandPalette.jsx";
import { Dialog } from "../src/components/Dialog.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { escapeLayersSnapshot } from "../src/lib/escapeLayers.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FormsView } from "../src/views/FormsView.jsx";
import { TasksView } from "../src/views/TasksView.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

// The palette fades its scrim for 200 ms before it unmounts, as the
// prototype's search does.
const paletteGone = () => waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());
import { WorkstreamSettings } from "../src/views/WorkstreamSettings.jsx";
import { t as translate } from "../src/lib/i18n.js";

// BUG-UG-COMPASS-ESCAPE-CLOSES-DIALOG-ABOVE-20260920: every overlay used to
// install its own window Escape listener, so one press closed every mounted
// layer — a Dialog above the rail-shell Compass panel also fired the panel's
// onClose and threw away the member's unsent draft. These tests pin the
// shared-stack contract: exactly one layer answers a given Escape.

const originalMatchMedia = window.matchMedia;

function stubMatchMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
}

function renderPanel({ onClose = vi.fn(), initialDraft = "", ...rest } = {}) {
  render(
    <LanguageProvider lang="en">
      <Assistant threads={[]} onSend={vi.fn()} onClose={onClose} initialDraft={initialDraft} {...rest} />
    </LanguageProvider>,
  );
  return onClose;
}

beforeEach(() => {
  // Desktop breakpoint matches → the panel renders as the non-modal rail shell.
  stubMatchMedia(true);
  window.localStorage.clear();
});

// After the storage reset above, so the choice survives it.
keepKeyboardShortcutsOn();

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("Escape arbitration between the Compass panel and layers above it", () => {
  it("one Escape closes only the dialog above the non-modal panel and keeps the draft", () => {
    const panelClose = renderPanel({ initialDraft: "mandated overtime question" });
    const dialogClose = vi.fn();
    render(
      <LanguageProvider lang="en">
        <Dialog title="Case detail" onClose={dialogClose}>Detail body</Dialog>
      </LanguageProvider>,
    );
    const composer = screen.getByLabelText("Ask Union Ground Guide a question");
    expect(composer).toHaveValue("mandated overtime question");

    fireEvent.keyDown(window, { key: "Escape" });

    // The dialog alone takes the key: it enters its closing phase, the panel
    // beneath never sees the press, and the unsent draft survives.
    const layer = document.querySelector('.sg-detail-layer[data-state="closing"]');
    expect(layer).not.toBeNull();
    expect(panelClose).not.toHaveBeenCalled();
    expect(composer).toHaveValue("mandated overtime question");

    fireEvent.transitionEnd(layer);
    expect(dialogClose).toHaveBeenCalledOnce();
    expect(panelClose).not.toHaveBeenCalled();
    expect(composer).toHaveValue("mandated overtime question");
  });

  it("one Escape still closes the non-modal panel when it is the only layer", () => {
    const panelClose = renderPanel();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelClose).toHaveBeenCalledOnce();
  });

  it("the takeover panel is a modal layer: one Escape closes it once", () => {
    stubMatchMedia(false);
    const panelClose = renderPanel();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelClose).toHaveBeenCalledOnce();
  });

  it("unregisters by identity so independent unmount order cannot corrupt the stack", () => {
    const panelClose = renderPanel();
    const dialog = render(
      <LanguageProvider lang="en">
        <Dialog title="Case detail" onClose={vi.fn()}>Detail body</Dialog>
      </LanguageProvider>,
    );
    // App mounts the assistant and dialogs from independent flags: the dialog
    // can leave while the panel stays. A pop-based stack would drop the panel.
    dialog.unmount();
    expect(escapeLayersSnapshot()).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelClose).toHaveBeenCalledOnce();
  });

  it("one Escape closes the command palette above the panel and leaves the panel open", async () => {
    const panelClose = renderPanel();
    render(
      <LanguageProvider lang="en">
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await paletteGone();
    expect(panelClose).not.toHaveBeenCalled();

    // Cmd+K still toggles the palette back open once the layer is gone.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("a parent re-render with a new onClose keeps the takeover panel below a palette opened after it", async () => {
    stubMatchMedia(false);
    const firstClose = vi.fn();
    const panel = render(
      <LanguageProvider lang="en">
        <Assistant threads={[]} onSend={vi.fn()} onClose={firstClose} initialDraft="grievance step two" />
      </LanguageProvider>,
    );
    render(
      <LanguageProvider lang="en">
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();

    // App re-renders (palette hydration) and hands the sheet a new inline onClose.
    const latestClose = vi.fn();
    panel.rerender(
      <LanguageProvider lang="en">
        <Assistant threads={[]} onSend={vi.fn()} onClose={latestClose} initialDraft="grievance step two" />
      </LanguageProvider>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await paletteGone();
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).not.toHaveBeenCalled();

    // The next Escape reaches the sheet through its latest callback.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(latestClose).toHaveBeenCalledOnce();
    expect(firstClose).not.toHaveBeenCalled();
  });

  it("a re-rendered guarded dialog stays below a palette opened after it", async () => {
    const dialogClose = vi.fn();
    // AdminView's MFA confirmation passes an inline beforeClose, so the guard
    // (and with it the dialog's close handler) has a new identity every render.
    const dialog = render(
      <LanguageProvider lang="en">
        <Dialog title="Confirm admin change" onClose={dialogClose} beforeClose={() => true}>Detail body</Dialog>
      </LanguageProvider>,
    );
    render(
      <LanguageProvider lang="en">
        <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />
      </LanguageProvider>,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();

    // The palette's onOpen hydration re-renders App, so the dialog renders again.
    dialog.rerender(
      <LanguageProvider lang="en">
        <Dialog title="Confirm admin change" onClose={dialogClose} beforeClose={() => true}>Detail body</Dialog>
      </LanguageProvider>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await paletteGone();
    expect(document.querySelector('.sg-detail-layer[data-state="closing"]')).toBeNull();
    expect(dialogClose).not.toHaveBeenCalled();

    // The next Escape belongs to the dialog, guard and all.
    fireEvent.keyDown(window, { key: "Escape" });
    const layer = await waitFor(() => {
      const closing = document.querySelector('.sg-detail-layer[data-state="closing"]');
      expect(closing).not.toBeNull();
      return closing;
    });
    fireEvent.transitionEnd(layer);
    expect(dialogClose).toHaveBeenCalledOnce();
  });

  it("one Escape closes the Kanban shortcuts sheet above the panel and leaves the panel open", async () => {
    window.history.replaceState({}, "", "/m/tasks");
    const panelClose = renderPanel({ initialDraft: "staffing ratios" });
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
      </LanguageProvider>,
    );

    // Bare ? is opt-in (WCAG 2.1.4); the help button in Board view settings always opens the sheet.
    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
    expect(panelClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Ask Union Ground Guide a question")).toHaveValue("staffing ratios");
  });

  it("one Escape cancels the Forms co-sign edit confirm above the panel and keeps the draft", () => {
    const panelClose = renderPanel({ initialDraft: "unsafe staffing ratios" });
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={structuredClone(fallbackData)}
          onSaveDraft={vi.fn()}
          onSubmit={vi.fn()}
          onInviteCosigner={vi.fn()}
          onRespondCosign={vi.fn()}
          onWithdrawCosign={vi.fn()}
          onSignForm={vi.fn()}
        />
      </LanguageProvider>,
    );

    // The alliance draft has an accepted co-signer, so resuming it pauses on
    // the edit warning alertdialog.
    const resumes = screen.getAllByRole("button", { name: "Resume draft" });
    fireEvent.click(resumes[resumes.length - 1]);
    expect(screen.getByRole("alertdialog", { name: "Edit a co-signed grievance?" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(panelClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Ask Union Ground Guide a question")).toHaveValue("unsafe staffing ratios");
  });

  it("a modal that keeps its own Escape listener (workstream settings) outranks the panel opened before it", () => {
    // The panel mounts first, so the shared listener runs before the modal's
    // own window listener. The non-modal panel must yield to the open
    // aria-modal surface instead of closing and discarding the draft.
    const panelClose = renderPanel({ initialDraft: "shift swap question" });
    const settingsClose = vi.fn();
    render(
      <WorkstreamSettings
        t={(key, params) => translate("en", key, params)}
        workstreams={[]}
        tasks={[]}
        onClose={settingsClose}
        onRename={vi.fn()}
        onPreviewMerge={vi.fn()}
        onMerge={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    const layer = document.querySelector('.sg-detail-layer[data-state="closing"]');
    expect(layer).not.toBeNull();
    expect(panelClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Ask Union Ground Guide a question")).toHaveValue("shift swap question");
    fireEvent.transitionEnd(layer);
    expect(settingsClose).toHaveBeenCalledOnce();
    expect(panelClose).not.toHaveBeenCalled();
  });
});
