import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/components/Dialog.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { DETAIL_SURFACE_EXIT_MS } from "../src/lib/useDetailSurface.js";
import { useTransitionPresence } from "../src/lib/useTransitionPresence.js";
import { TasksView } from "../src/views/TasksView.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const realMatchMedia = window.matchMedia;
const realRequestAnimationFrame = window.requestAnimationFrame;
const realCancelAnimationFrame = window.cancelAnimationFrame;
const realStartViewTransition = document.startViewTransition;

function media(matches = false) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes("prefers-reduced-motion") ? matches : true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

function renderTasks(overrides = {}) {
  const props = {
    data: structuredClone(fallbackData),
    onProfile: vi.fn(),
    onAssistant: vi.fn(),
    onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task", taskNumber: 99 })),
    onUpdateTask: vi.fn(async (_id, fields) => fields),
    onDeleteTask: vi.fn(async () => ({ deleted: true })),
    onSendTaskMessage: vi.fn(async () => null),
    ...overrides,
  };
  render(<LanguageProvider lang="en"><TasksView {...props} /></LanguageProvider>);
  return props;
}

function PresenceHarness({ open, onExited = null }) {
  const presence = useTransitionPresence(open, { exitMs: 200, onExited });
  if (!presence.mounted) return null;
  return (
    <div
      data-testid="surface"
      data-state={presence.phase}
      inert={presence.closing ? true : undefined}
      onTransitionEnd={presence.onTransitionEnd}
    />
  );
}

function DetailDialogHarness() {
  const [open, setOpen] = useState(true);
  return open ? (
    <Dialog eyebrow="Shared detail" title="Case detail" onClose={() => setOpen(false)}>
      <p>Retained content</p>
    </Dialog>
  ) : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  media(false);
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  window.history.replaceState({}, "", "/m/tasks");
  document.title = "Union Ground";
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
  window.requestAnimationFrame = realRequestAnimationFrame;
  window.cancelAnimationFrame = realCancelAnimationFrame;
  if (realStartViewTransition) document.startViewTransition = realStartViewTransition;
  else delete document.startViewTransition;
  window.history.replaceState({}, "", "/m/tasks");
  document.body.style.overflow = "";
});

describe("transition presence primitive", () => {
  it("keeps a closing node inert and invalidates a stale close when reopened", () => {
    const onExited = vi.fn();
    const { rerender } = render(<PresenceHarness open onExited={onExited} />);
    expect(screen.getByTestId("surface")).toHaveAttribute("data-state", "opening");
    act(() => vi.advanceTimersByTime(32));
    expect(screen.getByTestId("surface")).toHaveAttribute("data-state", "open");

    rerender(<PresenceHarness open={false} onExited={onExited} />);
    expect(screen.getByTestId("surface")).toHaveAttribute("data-state", "closing");
    expect(screen.getByTestId("surface")).toHaveAttribute("inert");
    act(() => vi.advanceTimersByTime(100));

    rerender(<PresenceHarness open onExited={onExited} />);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId("surface")).toHaveAttribute("data-state", "open");
    expect(onExited).not.toHaveBeenCalled();
  });

  it("uses transitionend with a timeout fallback and skips the wait in reduced motion", () => {
    const onExited = vi.fn();
    const { rerender } = render(<PresenceHarness open onExited={onExited} />);
    act(() => vi.advanceTimersByTime(32));
    rerender(<PresenceHarness open={false} onExited={onExited} />);
    fireEvent.transitionEnd(screen.getByTestId("surface"));
    expect(screen.queryByTestId("surface")).not.toBeInTheDocument();
    expect(onExited).toHaveBeenCalledTimes(1);

    media(true);
    rerender(<PresenceHarness open onExited={onExited} />);
    act(() => vi.advanceTimersByTime(16));
    rerender(<PresenceHarness open={false} onExited={onExited} />);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.queryByTestId("surface")).not.toBeInTheDocument();
  });
});

describe("tasks interaction grammar", () => {
  it("moves segmented-control focus manually and activates only on Enter", () => {
    renderTasks();
    const group = screen.getByRole("group", { name: "Task views" });
    const board = within(group).getByRole("button", { name: "Board" });
    const list = within(group).getByRole("button", { name: "List" });
    board.focus();
    fireEvent.keyDown(board, { key: "ArrowRight" });
    expect(list).toHaveFocus();
    expect(board).toHaveAttribute("tabindex", "-1");
    expect(list).toHaveAttribute("tabindex", "0");
    expect(board).toHaveAttribute("aria-pressed", "true");
    expect(list).toHaveAttribute("aria-pressed", "false");
    expect(group.querySelectorAll(".kan-views__indicator")).toHaveLength(1);
    expect(group).toHaveStyle({ "--kan-view-index": "0" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(group.querySelectorAll(".kan-views__indicator")).toHaveLength(1);
    expect(group).toHaveStyle({ "--kan-view-index": "1" });
  });

  it("retains a popover through close and a rapid reopen cancels stale removal", () => {
    renderTasks();
    const trigger = screen.getByRole("button", { name: "Board view settings" });
    fireEvent.click(trigger);
    fireEvent.scroll(window);
    act(() => vi.advanceTimersByTime(32));
    let panel = document.querySelector(".kan-popover--settings");
    expect(panel).toHaveAttribute("data-state", "open");

    screen.getByRole("switch", { name: "Display done tasks" }).focus();
    fireEvent.click(trigger);
    panel = document.querySelector(".kan-popover--settings");
    expect(panel).toHaveAttribute("data-state", "closing");
    expect(panel).toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(trigger);
    act(() => vi.advanceTimersByTime(300));
    panel = document.querySelector(".kan-popover--settings");
    expect(panel).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("switch", { name: "Display done tasks" })).toBeInTheDocument();
  });

  it("keeps internal popover scrolling open and dismisses on viewport movement", () => {
    renderTasks();
    const trigger = screen.getByRole("button", { name: "Board view settings" });
    fireEvent.click(trigger);
    act(() => vi.advanceTimersByTime(32));
    let panel = document.querySelector(".kan-popover--settings");
    fireEvent.scroll(panel);
    expect(panel).toHaveAttribute("data-state", "open");
    fireEvent.scroll(window);
    expect(panel).toHaveAttribute("data-state", "closing");
    act(() => vi.advanceTimersByTime(250));

    fireEvent.click(trigger);
    act(() => vi.advanceTimersByTime(32));
    panel = document.querySelector(".kan-popover--settings");
    expect(panel).toHaveAttribute("data-state", "open");
    fireEvent.resize(window);
    expect(panel).toHaveAttribute("data-state", "closing");
  });

  it("finishes a contextual popover exit when Report removes its toolbar controls", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Filter tasks" }));
    act(() => vi.advanceTimersByTime(32));
    const panel = document.querySelector(".kan-popover--filter");
    expect(panel).toHaveAttribute("data-state", "open");

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(screen.getByRole("button", { name: "Report" })).toHaveAttribute("aria-pressed", "true");
    expect(panel).toHaveAttribute("data-state", "closing");
    expect(panel).toHaveAttribute("inert");
    act(() => vi.advanceTimersByTime(250));
    expect(document.querySelector(".kan-popover--filter")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    act(() => vi.advanceTimersByTime(32));
    expect(document.querySelector(".kan-popover--filter")).toBeNull();
    expect(screen.getByRole("button", { name: "Filter tasks" })).toHaveAttribute("aria-expanded", "false");
  });

  it("locks and inerts the full app shell until the workspace exit completes", () => {
    const rail = document.createElement("nav");
    rail.setAttribute("aria-label", "Test rail");
    document.body.appendChild(rail);
    renderTasks();
    const source = screen.getByRole("button", { name: "Translate bargaining pulse" });
    source.focus();
    fireEvent.click(source);
    act(() => vi.advanceTimersByTime(32));
    const layer = document.querySelector('.kan-modal-backdrop[data-state="open"]');
    expect(layer).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.querySelector(".kan-viewstage")).toHaveAttribute("inert");
    expect(rail).toHaveAttribute("inert");
    expect(rail).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(within(layer).getByRole("button", { name: "Close task editor" }));
    expect(layer).toHaveAttribute("data-state", "closing");
    expect(layer).not.toHaveAttribute("inert");
    act(() => vi.advanceTimersByTime(DETAIL_SURFACE_EXIT_MS - 1));
    expect(document.body.contains(layer)).toBe(true);
    fireEvent.transitionEnd(layer);
    act(() => vi.advanceTimersByTime(32));
    expect(document.body.contains(layer)).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.querySelector(".kan-viewstage")).not.toHaveAttribute("inert");
    expect(rail).not.toHaveAttribute("inert");
    expect(rail).not.toHaveAttribute("aria-hidden");
    expect(source).toHaveFocus();
    rail.remove();
  });

  it("isolates late shell branches and blocks background shortcuts while a workspace owns interaction", async () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Translate bargaining pulse" }));
    act(() => vi.advanceTimersByTime(32));

    const late = document.createElement("aside");
    late.setAttribute("aria-label", "Late shell branch");
    await act(async () => {
      document.body.appendChild(late);
      await Promise.resolve();
    });
    expect(late).toHaveAttribute("inert");
    expect(late).toHaveAttribute("aria-hidden", "true");

    fireEvent.keyDown(window, { key: "c" });
    fireEvent.keyDown(window, { key: "?" });
    fireEvent.keyDown(window, { key: "C", ctrlKey: true, shiftKey: true });
    expect(screen.queryByPlaceholderText("Task title…")).not.toBeInTheDocument();
    expect(document.querySelector(".kan-shortcuts")).toBeNull();
    expect(screen.getByRole("button", { name: "Board", hidden: true })).toHaveAttribute("aria-pressed", "true");

    const workspace = document.querySelector(".kan-modal-backdrop");
    fireEvent.click(within(workspace).getByRole("button", { name: "Close task editor" }));
    fireEvent.transitionEnd(workspace);
    await act(async () => { await Promise.resolve(); });
    expect(late).not.toHaveAttribute("inert");
    expect(late).not.toHaveAttribute("aria-hidden");
    late.remove();
  });

  it("lets Escape close the delete confirmation without closing its workspace", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Translate bargaining pulse" }));
    act(() => vi.advanceTimersByTime(32));
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(within(screen.getByRole("alertdialog")).getByRole("status")).toHaveAttribute("aria-live", "polite");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".task-editor-backdrop")).toHaveAttribute("data-state", "closing");
    expect(document.querySelector(".kan-modal-backdrop")).toHaveAttribute("data-state", "open");

    act(() => vi.advanceTimersByTime(250));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens the current view's inline composer after an asynchronous native view update", async () => {
    document.startViewTransition = vi.fn((update) => {
      const updateCallbackDone = Promise.resolve().then(update);
      return { updateCallbackDone, ready: updateCallbackDone, finished: updateCallbackDone };
    });
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(document.querySelector(".kan-list")).getAllByRole("button", { name: "New task" })[0]);
    await act(async () => { await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(32));
    expect(screen.getByPlaceholderText("Task title")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "C", ctrlKey: true, shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(document.startViewTransition).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Calendar" })).toHaveAttribute("aria-pressed", "true");
  });

  it("consumes aborted native view-transition lifecycle promises", () => {
    const catches = [vi.fn(), vi.fn(), vi.fn()];
    document.startViewTransition = vi.fn((update) => {
      update();
      return {
        ready: { catch: catches[0] },
        updateCallbackDone: { catch: catches[1] },
        finished: { catch: catches[2] },
      };
    });
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    for (const consume of catches) expect(consume).toHaveBeenCalledWith(expect.any(Function));
  });

  it("animates intrinsic disclosure height and exposes progress values", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Translate bargaining pulse" }));
    act(() => vi.advanceTimersByTime(32));
    const disclosure = screen.getByRole("button", { name: "Dependencies" });
    expect(screen.getByRole("heading", { level: 3, name: "Dependencies" })).toContainElement(disclosure);
    expect(screen.getByRole("heading", { level: 3, name: "Subtasks" })).toContainElement(
      screen.getByRole("button", { name: "Subtasks" }),
    );
    const panelId = disclosure.getAttribute("aria-controls");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    const panel = document.getElementById(panelId);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveAttribute("data-state", "opening");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("data-state", "closing");
    expect(panel).toHaveAttribute("inert");
    fireEvent.transitionEnd(panel);
    expect(document.getElementById(panelId)).toBeNull();

    const workspace = document.querySelector(".kan-modal-backdrop");
    fireEvent.click(within(workspace).getByRole("button", { name: "Close task editor" }));
    fireEvent.transitionEnd(workspace);
    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    const bars = screen.getAllByRole("progressbar");
    expect(bars.length).toBeGreaterThan(1);
    for (const bar of bars) {
      expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(0);
      expect(Number(bar.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(100);
    }
  });

  it("keeps switch name stable and includes visible non-color state cues", () => {
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    const toggle = screen.getByRole("switch", { name: "Display done tasks" });
    expect(toggle.querySelector(".sg-switch__cue--off")).toHaveTextContent("×");
    expect(toggle.querySelector(".sg-switch__cue--on")).toHaveTextContent("✓");
    fireEvent.click(toggle);
    expect(screen.getByRole("switch", { name: "Display done tasks" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("app-wide detail surface lifecycle", () => {
  it("retains a standard dialog through the shared close and keeps the shell isolated", () => {
    const rail = document.createElement("nav");
    rail.setAttribute("aria-label", "Shared detail test rail");
    document.body.appendChild(rail);
    render(<LanguageProvider lang="en"><DetailDialogHarness /></LanguageProvider>);
    act(() => vi.advanceTimersByTime(32));

    const layer = document.querySelector('.sg-detail-layer[data-state="open"]');
    expect(layer).toHaveClass("dialog-backdrop");
    expect(layer.querySelector(".sg-detail-surface")).toHaveClass("app-dialog");
    expect(document.body.style.overflow).toBe("hidden");
    expect(rail).toHaveAttribute("inert");

    fireEvent.click(within(layer).getByRole("button", { name: "Close" }));
    expect(layer).toHaveAttribute("data-state", "closing");
    // The prototype's modal keeps focus inside while its scrim fades;
    // the dialog declines input by state.
    expect(layer).not.toHaveAttribute("inert");
    act(() => vi.advanceTimersByTime(DETAIL_SURFACE_EXIT_MS - 1));
    expect(document.body.contains(layer)).toBe(true);
    fireEvent.transitionEnd(layer);
    expect(document.body.contains(layer)).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(rail).not.toHaveAttribute("inert");
    rail.remove();
  });

  it("dismisses a standard dialog only for Escape while it is open", () => {
    render(<LanguageProvider lang="en"><DetailDialogHarness /></LanguageProvider>);
    act(() => vi.advanceTimersByTime(32));
    const layer = document.querySelector('.sg-detail-layer[data-state="open"]');

    fireEvent.keyDown(window, { key: "Enter" });
    expect(layer).toHaveAttribute("data-state", "open");
    expect(fireEvent.keyDown(window, { key: "Escape", cancelable: true })).toBe(false);
    expect(layer).toHaveAttribute("data-state", "closing");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(layer).toHaveAttribute("data-state", "closing");
    fireEvent.transitionEnd(layer);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dismisses from the backdrop without treating dialog interaction as outside", () => {
    render(<LanguageProvider lang="en"><DetailDialogHarness /></LanguageProvider>);
    act(() => vi.advanceTimersByTime(32));
    const layer = document.querySelector('.sg-detail-layer[data-state="open"]');

    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(layer).toHaveAttribute("data-state", "open");
    fireEvent.mouseDown(layer);
    expect(layer).toHaveAttribute("data-state", "closing");
    fireEvent.mouseDown(layer);
    expect(layer).toHaveAttribute("data-state", "closing");
    fireEvent.transitionEnd(layer);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("canonical motion wiring", () => {
  const motion = read("src/motion.css");
  const styles = read("src/styles.css");
  const tokens = read("src/sg-tokens.css");

  it("pins the measured durations, curves and transforms to canonical tokens", () => {
    for (const token of [
      "--sg-motion-duration-default: 150ms",
      "--sg-motion-duration-base: 200ms",
      "--sg-motion-duration-moderate: 300ms",
      "--sg-motion-duration-disclosure: 350ms",
      "--sg-motion-duration-settle: 500ms",
      "--sg-motion-duration-scene: 600ms",
      "--sg-motion-ease-pop: cubic-bezier(0,1,0,1.025)",
      "--sg-motion-scale-workspace-closed: 0.15",
      "--sg-motion-scale-drag-board: 1.05",
      "--sg-motion-scale-drag-calendar: 0.975",
    ]) expect(tokens).toContain(token);
    expect(motion).toContain('.kan-popover[data-state="open"]');
    expect(DETAIL_SURFACE_EXIT_MS).toBe(200);
    expect(motion).toContain('.sg-detail-layer[data-state="open"] .sg-detail-surface');
    expect(motion).toContain('transform: translateY(var(--detail-surface-closed-y))');
    // REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: the entrance
    // starts a few pixels low and settles within the base duration; the long
    // rise kept buttons moving under the first click. The exit keeps its travel.
    expect(motion).not.toContain('calc(var(--sg-motion-duration-scene) + var(--sg-motion-duration-base))');
    expect(motion).toContain('.sg-detail-layer[data-state="opening"] .sg-detail-surface {\n  transform: translateY(var(--detail-surface-enter-y, 12px));');
    expect(motion).toContain('transition-duration: var(--sg-motion-duration-base), var(--sg-motion-duration-base);\n  transition-timing-function: var(--sg-motion-ease-out), var(--sg-motion-ease-out);');
    expect(read("src/views/TaskModal.jsx")).toContain('first?.focus({ preventScroll: true })');
    expect(styles).toContain('--detail-surface-closed-y: calc(100dvh - 20px)');
    expect(styles).toContain('--detail-surface-closed-y: calc(100% + 16px)');
    expect(styles).toContain("grid-template-rows var(--sg-motion-duration-disclosure)");
    expect(motion).toContain(':not(.kan-chip--drag)):active');
    expect(styles).toContain(':not(.kan-chip--drag)):active');
    expect(styles).toContain('.kan-seg button { display: inline-flex; min-height: 44px');
    expect(styles).toContain('.kan-pill--icon { width: 44px; min-width: 44px; max-width: 44px; flex: 0 0 44px');
    expect(styles).toMatch(/\.kan-views :is\(button, a\) \{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/);
    expect(styles).toContain('.phead__btn { display: grid; place-items: center; width: 44px; height: 44px');
    expect(styles).toContain('.kan-ws-head__focus { display: grid; width: 44px; height: 44px');
    expect(styles).toMatch(/\.kan-card__title \{[\s\S]*?min-height: 44px;/);
    expect(styles).toContain('.kan-checkrow__box { display: grid; width: 44px; height: 44px');
    expect(styles).toContain('.timeline-row__label > button { min-width: 0; min-height: 44px');
    // The bar IS the target now. It used to be 29px tall with a 44px ::after
    // hit area, and the 2026-09-12 acceptance audit failed it anyway: the audit
    // measures the element's own rectangle, so a pseudo-element hit area buys
    // nothing there. 44px centred in the 62px track, with min-width 44px so a
    // one-day span is not a sliver.
    expect(styles).toMatch(/\.timeline-bar \{[^}]*top: 9px;[^}]*height: 44px;[^}]*min-width: 44px;/);
    expect(styles).not.toContain(".timeline-bar::after");
    expect(styles).toContain('.voting-quorum-row { display: flex; min-height: 44px');
    expect(styles).toContain('.voting-btn { min-height: 44px');
    expect(styles).toContain('.voting-scope { min-height: 44px');
  });
});
