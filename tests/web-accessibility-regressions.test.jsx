import axe from "axe-core";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActionToast } from "../src/App.jsx";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { RadioGroup } from "../src/components/RadioGroup.jsx";
import { TOAST_LEAVE_MS, TOAST_LIFETIME_MS } from "../src/lib/useToastLifetime.js";
import { TasksView } from "../src/views/TasksView.jsx";

function AssistantHarness() {
  const [open, setOpen] = useState(false);
  return <main id="main-content" tabIndex={-1}><button type="button" onClick={() => setOpen(true)}>Open Compass</button>{open && <Assistant onClose={() => setOpen(false)} onSend={vi.fn()} threads={[]} />}</main>;
}

function ToastHarness() {
  const [notice, setNotice] = useState("First action");
  return <><main id="main-content" tabIndex={-1}>Workspace</main><button type="button" onClick={() => setNotice("Second action")}>Show second action</button><ActionToast notice={notice} action={{ label: "Undo" }} onDismiss={() => setNotice("")} onAction={() => setNotice("")} /></>;
}

function UnmountingAssistantHarness() {
  const [open, setOpen] = useState(false);
  const [showOpener, setShowOpener] = useState(true);
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => setShowOpener(false), 0);
    return () => window.clearTimeout(timer);
  }, [open]);
  return <main id="main-content" tabIndex={-1}>
    {showOpener && <button type="button" onClick={() => setOpen(true)}>Open Compass</button>}
    {open && <Assistant onClose={() => setOpen(false)} onSend={vi.fn()} threads={[]} />}
  </main>;
}

function DesktopAssistantHarness() {
  const [open, setOpen] = useState(false);
  return <main id="main-content" tabIndex={-1}>
    <button type="button" onClick={() => setOpen(true)}>Open Compass</button>
    {open && <Assistant onClose={() => setOpen(false)} onSend={vi.fn()} threads={[]} />}
  </main>;
}

function RadioGroupHarness({ initial }) {
  const [value, setValue] = useState(initial);
  return (
    <RadioGroup aria-label="Scope">
      {["chapter", "local", "region"].map((key) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} onClick={() => setValue(key)}>{key}</button>
      ))}
    </RadioGroup>
  );
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.jsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("web accessibility regressions", () => {
  it("describes the short-lived task Undo honestly in both locales", () => {
    for (const copy of [catalogue.en["tasks.deleteRecoverable"], catalogue.es["tasks.deleteRecoverable"]]) {
      expect(copy).toMatch(/Undo is offered briefly|Se puede deshacer justo después/);
      expect(copy).not.toMatch(/90 days|90 días/);
    }
  });

  it("matches the Compass chat element with the stylesheet selector that owns its scroll geometry", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const { container } = render(<LanguageProvider lang="en"><main id="main-content"><Assistant onClose={vi.fn()} onSend={vi.fn()} threads={[]} /></main></LanguageProvider>);
    const chat = container.querySelector(".assistant-chat");
    expect(styles).toContain(".assistant > .assistant-chat { display: flex;");
    expect(chat).not.toBeNull();
    expect(chat.matches(".assistant > .assistant-chat")).toBe(true);
  });

  it("pauses an action toast while it is focused, then returns timer dismissal to the main landmark", () => {
    vi.useFakeTimers();
    try {
      const dismiss = vi.fn();
      render(<><main id="main-content" tabIndex={-1}>Workspace</main><ActionToast notice="Task removed." action={{ label: "Undo" }} onDismiss={dismiss} /></>);
      const undo = screen.getByRole("button", { name: "Undo" });
      act(() => undo.focus());
      vi.advanceTimersByTime(7000);
      expect(dismiss).not.toHaveBeenCalled();
      fireEvent.blur(undo);
      act(() => vi.advanceTimersByTime(TOAST_LIFETIME_MS));
      act(() => vi.advanceTimersByTime(TOAST_LEAVE_MS));
      expect(dismiss).toHaveBeenCalledOnce();
      expect(document.getElementById("main-content")).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets an Undo pause for a later action toast and dismisses it after its own timer", () => {
    vi.useFakeTimers();
    try {
      render(<ToastHarness />);
      const undo = screen.getByRole("button", { name: "Undo" });
      fireEvent.focus(undo);
      fireEvent.click(undo);
      fireEvent.click(screen.getByRole("button", { name: "Show second action" }));
      act(() => vi.advanceTimersByTime(TOAST_LIFETIME_MS));
      act(() => vi.advanceTimersByTime(TOAST_LEAVE_MS));
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes an action toast when its pointer leaves to the browser window", () => {
    vi.useFakeTimers();
    try {
      const dismiss = vi.fn();
      render(<><main id="main-content" tabIndex={-1}>Workspace</main><ActionToast notice="Task removed." action={{ label: "Undo" }} onDismiss={dismiss} /></>);
      const toast = document.querySelector(".toast");
      act(() => fireEvent.mouseEnter(toast));
      expect(() => fireEvent.mouseLeave(toast)).not.toThrow();
      act(() => vi.advanceTimersByTime(TOAST_LIFETIME_MS));
      act(() => vi.advanceTimersByTime(TOAST_LEAVE_MS));
      expect(dismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Undo focused after 8 seconds when the pointer enters and leaves the focused toast", () => {
    vi.useFakeTimers();
    try {
      render(<ToastHarness />);
      const toast = screen.getByRole("status");
      const undo = screen.getByRole("button", { name: "Undo" });
      act(() => undo.focus());
      fireEvent.mouseEnter(toast);
      fireEvent.mouseLeave(toast);
      act(() => vi.advanceTimersByTime(8_000));
      expect(toast).toBeInTheDocument();
      expect(undo).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a hovered toast present after 8 seconds when focus enters and leaves it", () => {
    vi.useFakeTimers();
    try {
      render(<ToastHarness />);
      const toast = screen.getByRole("status");
      const undo = screen.getByRole("button", { name: "Undo" });
      const outside = screen.getByRole("button", { name: "Show second action" });
      fireEvent.mouseEnter(toast);
      act(() => undo.focus());
      act(() => outside.focus());
      act(() => vi.advanceTimersByTime(8_000));
      expect(toast).toBeInTheDocument();
      expect(outside).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart a plain notice timer when its parent rerenders", () => {
    vi.useFakeTimers();
    try {
      const dismiss = vi.fn();
      function RerenderingParent() {
        const [renders, setRenders] = useState(0);
        window.setTimeout(() => setRenders((value) => value + 1), 1_000);
        return <ActionToast notice="Saved" onDismiss={dismiss} />;
      }
      render(<RerenderingParent />);
      act(() => vi.advanceTimersByTime(TOAST_LIFETIME_MS));
      act(() => vi.advanceTimersByTime(TOAST_LEAVE_MS));
      expect(dismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("A11Y-UG-COMPASS-TAKEOVER-FOCUS-RETURN-20260907 returns takeover Compass focus to its opener for close-button and Escape dismissal", async () => {
    render(<LanguageProvider lang="en"><AssistantHarness /></LanguageProvider>);
    const opener = screen.getByRole("button", { name: "Open Compass" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close and discard this draft" }));
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(opener);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps the Compass chat region out of the page-main landmark count", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    const { container } = render(<LanguageProvider lang="en"><main id="main-content"><Assistant onClose={vi.fn()} onSend={vi.fn()} threads={[]} /></main></LanguageProvider>);
    const results = await axe.run(container, { runOnly: { type: "rule", values: ["landmark-one-main", "landmark-main-is-top-level"] } });
    expect(results.violations).toEqual([]);
    window.matchMedia = originalMatchMedia;
  });

  it("A11Y-UG-COMPASS-TAKEOVER-FOCUS-RETURN-20260907 falls back to the main landmark when its focused opener is removed after mount", async () => {
    render(<LanguageProvider lang="en"><UnmountingAssistantHarness /></LanguageProvider>);
    const opener = screen.getByRole("button", { name: "Open Compass" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Union Ground Guide" });
    await waitFor(() => expect(opener).not.toBeInTheDocument());
    const decoy = document.createElement("button");
    document.body.append(decoy);
    decoy.focus();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Close and discard this draft" }));

      await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
      expect(document.activeElement).toBe(document.getElementById("main-content"));
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      decoy.remove();
    }
  });

  it("A11Y-UG-COMPASS-TAKEOVER-FOCUS-RETURN-20260907 moves desktop Compass focus into the question box and restores the opener on Escape", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    try {
      render(<LanguageProvider lang="en"><DesktopAssistantHarness /></LanguageProvider>);
      const opener = screen.getByRole("button", { name: "Open Compass" });
      opener.focus();
      fireEvent.click(opener);
      await screen.findByRole("dialog", { name: "Union Ground Guide" });
      expect(screen.getByRole("textbox", { name: "Ask Union Ground Guide a question" })).toHaveFocus();
      expect(opener).not.toHaveFocus();
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it("A11Y-UG-LIVE-POLL-PROJECTOR-MODAL-CONTRACT-20260907 isolates and restores the engagement tab list", async () => {
    const client = { channel: vi.fn(), removeChannel: vi.fn() };
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({
      presence: { online: 1 },
      delivery: {},
      members: [],
      surveys: [],
      livePolls: [{ id: "poll", title: "Poll", state: "draft", voteCount: 0, results: [], attendance: {} }],
      pulsePrompts: [],
      channels: [],
    });
    render(<StaffEngagement client={client} session={{ access_token: "token" }} />);
    await screen.findByTestId("staff-engagement");
    fireEvent.click(screen.getByRole("button", { name: "Live polls" }));
    const opener = screen.getByRole("button", { name: "Projector view" });
    fireEvent.click(opener);
    const tabList = document.querySelector('nav[aria-label="Engagement workspace"]');
    expect(tabList).not.toBeNull();
    expect(tabList).toHaveAttribute("inert");
    expect(tabList).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(tabList).not.toHaveAttribute("inert");
    expect(tabList).not.toHaveAttribute("aria-hidden");
  });

  it("A11Y-UG-WEB-TASKS-SHORTCUTS-SHEET-NO-MODAL-ISOLATION-20260920 isolates the Tasks shortcuts dialog", async () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    window.history.replaceState({}, "", "/m/tasks");
    try {
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
      fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
      const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
      const backdrop = dialog.closest(".kan-modal-backdrop");
      const isolated = [];
      let branch = backdrop;
      while (branch?.parentElement && branch !== document.body) {
        for (const child of branch.parentElement.children) {
          if (child === branch || ["SCRIPT", "STYLE", "LINK"].includes(child.tagName)) continue;
          isolated.push(child);
        }
        branch = branch.parentElement;
      }
      expect(isolated.length).toBeGreaterThan(0);
      for (const node of isolated) {
        expect(node).toHaveAttribute("inert");
        expect(node).toHaveAttribute("aria-hidden", "true");
      }

      const close = within(dialog).getByRole("button", { name: "Close task editor" });
      expect(close).toHaveFocus();
      // The production keydown handler must wrap Tab itself: nothing here
      // moves focus, so a missing boundary handler leaves the press
      // un-prevented and focus free to leave the dialog.
      for (const shiftKey of [false, true]) {
        const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
        close.dispatchEvent(tab);
        expect(tab.defaultPrevented).toBe(true);
        expect(close).toHaveFocus();
      }
      close.blur();
      expect(document.activeElement).toBe(document.body);
      const stray = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      document.body.dispatchEvent(stray);
      expect(stray.defaultPrevented).toBe(true);
      expect(close).toHaveFocus();

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
      for (const node of isolated) {
        expect(node).not.toHaveAttribute("inert");
        expect(node).not.toHaveAttribute("aria-hidden");
      }
    } finally {
      window.matchMedia = realMatchMedia;
      window.history.replaceState({}, "", "/");
    }
  });

  it("A11Y-UG-CUSTOM-RADIOGROUPS-NO-KEYBOARD-MODEL-20260920 gives a custom radiogroup one Tab stop and the arrow, Home and End model its role promises", () => {
    render(<RadioGroupHarness initial="chapter" />);
    const options = () => screen.getAllByRole("radio");
    const tabStops = () => options().filter((option) => option.tabIndex === 0);
    const checked = () => options().filter((option) => option.getAttribute("aria-checked") === "true");

    expect(options()).toHaveLength(3);
    // One Tab stop, on the checked option.
    expect(tabStops()).toEqual([options()[0]]);
    expect(checked()).toEqual([options()[0]]);

    act(() => options()[0].focus());
    fireEvent.keyDown(options()[0], { key: "ArrowRight" });
    expect(options()[1]).toHaveFocus();
    expect(checked()).toEqual([options()[1]]);
    expect(tabStops()).toEqual([options()[1]]);

    fireEvent.keyDown(options()[1], { key: "ArrowDown" });
    expect(checked()).toEqual([options()[2]]);

    // Both ends wrap.
    fireEvent.keyDown(options()[2], { key: "ArrowRight" });
    expect(options()[0]).toHaveFocus();
    expect(checked()).toEqual([options()[0]]);
    fireEvent.keyDown(options()[0], { key: "ArrowLeft" });
    expect(options()[2]).toHaveFocus();
    expect(checked()).toEqual([options()[2]]);
    fireEvent.keyDown(options()[2], { key: "ArrowUp" });
    expect(checked()).toEqual([options()[1]]);

    fireEvent.keyDown(options()[1], { key: "Home" });
    expect(options()[0]).toHaveFocus();
    expect(checked()).toEqual([options()[0]]);
    fireEvent.keyDown(options()[0], { key: "End" });
    expect(options()[2]).toHaveFocus();
    expect(checked()).toEqual([options()[2]]);
    expect(tabStops()).toEqual([options()[2]]);

    // A pointer selection moves the Tab stop with it.
    fireEvent.click(options()[0]);
    expect(checked()).toEqual([options()[0]]);
    expect(tabStops()).toEqual([options()[0]]);

    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    options()[0].dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
  });

  it("A11Y-UG-CUSTOM-RADIOGROUPS-NO-KEYBOARD-MODEL-20260920 keeps an unchecked radiogroup reachable by Tab", () => {
    render(<RadioGroupHarness initial={null} />);
    const options = screen.getAllByRole("radio");
    expect(options.some((option) => option.getAttribute("aria-checked") === "true")).toBe(false);
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1, -1]);
  });

  it("A11Y-UG-CUSTOM-RADIOGROUPS-NO-KEYBOARD-MODEL-20260920 routes every web role=radiogroup surface through the shared keyboard model", () => {
    const root = resolve(process.cwd(), "src");
    const surfaces = sourceFiles(root)
      .filter((path) => /role\s*=\s*\{?\s*["']radiogroup/.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path).split("\\").join("/"));
    // A new surface that writes role="radiogroup" on its own element carries
    // none of the behaviour above, so the ratchet names the files allowed to
    // emit the role: the shared group, and MessageWorkflowPicker, whose own
    // roving model is covered by its tests. OrganizeView's campaign picker
    // renders through the shared group.
    expect(surfaces.sort()).toEqual(["src/components/MessageWorkflowPicker.jsx", "src/components/RadioGroup.jsx"]);
    expect(readFileSync(resolve(process.cwd(), "src/views/OrganizeView.jsx"), "utf8")).toContain("<RadioGroup aria-label={copy.campaignPicker}>");
  });

  it("defines .sr-only with the same clip/1px pattern as .visually-hidden", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(
      /\.visually-hidden,\s*\.sr-only \{ position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect\(0 0 0 0\); white-space: nowrap; border: 0; \}/,
    );
  });

  it("hides the decorative product mark inside view-loading", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const loadingNodes = [...app.matchAll(/className="view-loading"[^>]*>[\s\S]*?<\/div>/g)].map((match) => match[0]);
    // #6799: the three in-shell waits share one ViewLoading status group.
    expect(loadingNodes).toHaveLength(1);
    expect(app.match(/<ViewLoading\b/g)).toHaveLength(3);
    for (const node of loadingNodes) {
      expect(node).toContain('role="status"');
      expect(node).toContain('aria-live="polite"');
      expect(node).toContain('<span className="loading-screen__brand" aria-hidden="true"><BrandMark size={48} /></span>');
      expect(node).not.toMatch(/>\s*509\s*</);
    }
  });
});
