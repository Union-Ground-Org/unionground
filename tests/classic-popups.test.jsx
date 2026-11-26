import { readFileSync } from "node:fs";
import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionToast } from "../src/App.jsx";
import { ChapterSheet } from "../src/components/ChapterSheet.jsx";
import { DemoHatSelector } from "../src/components/DemoHatSelector.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { DemoWelcome, GuidedTour, PreviewGuide } from "../src/components/FloatingControls.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TOAST_LEAVE_MS, TOAST_LIFETIME_MS, useToastLifetime } from "../src/lib/useToastLifetime.js";
import { returnFocusAfterModal, useMenuPresence, useModalExit } from "../src/lib/useTransitionPresence.js";

// REQ-UG-CLASSIC-SHELL-POPUPS-TRANSITIONS-MATCH-PROTOTYPE-20261030:
// the classic shell's popups behave as the
// owner's save of the prototype's Work page does (core.js UG.modal, UG.toast,
// the menus and the tooltip). These pin the shared dialog, sheet, menu and
// toast behaviour in the classic shell: Escape, backdrop dismissal, focus
// trap and return, timing, and that reduced motion stays honoured. The
// Dialog's trap and the palette's fade are pinned for both shells in
// tests/alt-popups-dialogs.test.jsx.

const realMatchMedia = window.matchMedia;
const css = (path) => readFileSync(path, "utf8");

// Splits a selector list on its top-level commas only (not inside :is()/:not()).
function selectorParts(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === "(") depth += 1;
    else if (list[index] === ")") depth -= 1;
    else if (list[index] === "," && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

function reduceMotion(reduce) {
  window.matchMedia = vi.fn((query) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  reduceMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  document.body.style.overflow = "";
});

describe("the toast clock (useToastLifetime)", () => {
  it("stays 4.2 s, marks the .3s fade and expires at 320 ms", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useToastLifetime({ notice: "Saved", onExpire }));
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1); });
    expect(result.current.leaving).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.leaving).toBe(true);
    act(() => { vi.advanceTimersByTime(TOAST_LEAVE_MS - 1); });
    expect(onExpire).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(result.current.leaving).toBe(false);
  });

  it("holds while paused, restarts for a newer notice even mid-fade, and idles without one", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result, rerender } = renderHook((props) => useToastLifetime({ onExpire, ...props }), {
      initialProps: { notice: "Task removed", noticeId: 1, paused: true },
    });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS * 3); });
    expect(result.current.leaving).toBe(false);
    rerender({ notice: "Task removed", noticeId: 1, paused: false });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS); });
    expect(result.current.leaving).toBe(true);
    // A newer notice lands mid-fade: it is not leaving and its clock is fresh.
    rerender({ notice: "Task removed", noticeId: 2, paused: false });
    expect(result.current.leaving).toBe(false);
    act(() => { vi.advanceTimersByTime(TOAST_LEAVE_MS); });
    expect(onExpire).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS - TOAST_LEAVE_MS); });
    expect(result.current.leaving).toBe(true);
    rerender({ notice: "", noticeId: 3, paused: false });
    expect(result.current.leaving).toBe(false);
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS * 2); });
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("the toast clock when Undo is reached during the fade", () => {
  it("cancels the pending removal while paused, then runs a fresh lifetime when the interaction ends", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result, rerender } = renderHook((props) => useToastLifetime({ onExpire, ...props }), {
      initialProps: { notice: "Task removed", noticeId: 1, paused: false },
    });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS); });
    expect(result.current.leaving).toBe(true);
    // Focus or the pointer reaches Undo mid-fade.
    rerender({ notice: "Task removed", noticeId: 1, paused: true });
    expect(result.current.leaving).toBe(false);
    act(() => { vi.advanceTimersByTime(TOAST_LEAVE_MS * 5); });
    expect(onExpire).not.toHaveBeenCalled();
    // The interaction ends: a full lifetime, then the fade, then removal.
    rerender({ notice: "Task removed", noticeId: 1, paused: false });
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS); });
    expect(result.current.leaving).toBe(true);
    act(() => { vi.advanceTimersByTime(TOAST_LEAVE_MS); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});

describe("ActionToast in the classic shell", () => {
  it.each([[false], [true]])("rises in, fades from 4.2 s and is removed at 320 ms (reduced motion %s keeps the clock)", (reduce) => {
    vi.useFakeTimers();
    reduceMotion(reduce);
    const onDismiss = vi.fn();
    render(<LanguageProvider lang="en"><ActionToast notice="Task created" noticeId={1} onDismiss={onDismiss} /></LanguageProvider>);
    const toast = screen.getByRole("status");
    expect(toast).toHaveClass("toast");
    expect(toast).not.toHaveAttribute("data-leaving");
    act(() => { vi.advanceTimersByTime(TOAST_LIFETIME_MS); });
    expect(toast).toHaveAttribute("data-leaving", "true");
    act(() => { vi.advanceTimersByTime(TOAST_LEAVE_MS); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

const hats = [
  { key: "member", labelKey: "demo.hatMember" },
  { key: "committee member", labelKey: "demo.hatSteward" },
  { key: "campaign lead", labelKey: "demo.hatCoordinator" },
];

function HatHost() {
  const [active, setActive] = useState("committee member");
  return (
    <LanguageProvider lang="en">
      <DemoHatSelector options={hats} active={active} onChange={setActive} />
      <button type="button">Outside</button>
    </LanguageProvider>
  );
}

describe("menus (the demo hat menu)", () => {



  it("reports shown from the render that opens it, so the opener can place and focus it", () => {
    const { result, rerender } = renderHook(({ open }) => useMenuPresence(open), { initialProps: { open: false } });
    expect(result.current).toMatchObject({ shown: false, closing: true });
    rerender({ open: true });
    expect(result.current).toMatchObject({ shown: true, state: "opening", closing: false });
  });
});

describe("menus (the collapsed desktop rail's hat menu)", () => {
  it("fades out where it stood, inert, and hands focus back to its trigger on Escape", () => {
    vi.useFakeTimers();
    render(
      <LanguageProvider lang="en">
        <DesktopRail
          active="today"
          activeHat="member"
          demo={false}
          memberId="member-popups"
          onAsk={() => {}}
          onNavigate={() => {}}
          onNotifications={() => {}}
          onSwitchHat={() => {}}
          renderMode="desktop"
          staffPlanes={[{ key: "committee member", labelKey: "demo.hatSteward", path: "/m/steward" }]}
          user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse rail" }));
    const trigger = document.querySelector(".desktop-rail__hat-menu-trigger");
    fireEvent.click(trigger);
    const menu = document.querySelector(".desktop-rail__hat-menu");
    expect(menu).toHaveAttribute("data-state", "opening");
    act(() => { vi.advanceTimersByTime(40); });
    expect(menu).toHaveAttribute("data-state", "open");
    const placed = menu.getAttribute("style");
    fireEvent.keyDown(within(menu).getAllByRole("menuitemradio")[0], { key: "Escape" });
    expect(menu).toHaveAttribute("data-state", "closing");
    expect(menu).toHaveAttribute("inert");
    expect(menu.getAttribute("style")).toBe(placed);
    expect(trigger).toHaveFocus();
    fireEvent.transitionEnd(menu);
    expect(document.querySelector(".desktop-rail__hat-menu")).toBeNull();
  });
});

function SheetHost() {
  const [open, setOpen] = useState(false);
  return (
    <LanguageProvider lang="en">
      <button type="button" onClick={() => setOpen(true)}>Chapter</button>
      {open ? (
        <ChapterSheet
          chapterName="Cedar Ridge Care Services"
          memberTools={false}
          tools={[{ key: "tasks", labelKey: "staff.chapterWork", path: "/m/tasks", icon: "☑" }]}
          onNavigate={() => {}}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </LanguageProvider>
  );
}

function openSheet() {
  const opener = screen.getByRole("button", { name: "Chapter" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("the phone sheet (ChapterSheet on the shared Dialog)", () => {
  it("opens on its close button with the page locked, traps Tab, and closes on Escape after the scrim fade", async () => {
    render(<SheetHost />);
    const opener = openSheet();
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(document.body.style.overflow).toBe("hidden");
    const dialog = screen.getByRole("dialog");
    const link = screen.getByRole("link", { name: /Campaign work/ });
    link.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(link).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    const layer = document.querySelector(".dialog-backdrop");
    expect(layer).toHaveAttribute("data-state", "closing");
    expect(layer).not.toHaveAttribute("inert");
    expect(link).toHaveFocus();
    // A second Escape mid-fade is declined, not doubled.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.transitionEnd(layer);
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on a press on its scrim but not on one inside it", async () => {
    render(<SheetHost />);
    const opener = openSheet();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(document.querySelector(".dialog-backdrop")).toHaveAttribute("data-state", expect.stringMatching(/opening|open/));
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("leaves at once with reduced motion", async () => {
    reduceMotion(true);
    render(<SheetHost />);
    const opener = openSheet();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
    expect(opener).toHaveFocus();
  });
});

// The modals that mount open (the demo welcome, the preview guide and the tour
// here; the template picker and the keyboard sheet in tests/tasks-view.test.jsx,
// the co-sign edit warning in tests/forms-cosign-view.test.jsx and the
// campaign confirmation in tests/campaigns-view.test.jsx) close the way the
// prototype's UG.modal does: held for the 200 ms scrim fade, focus kept
// inside, repeated dismissals ignored, then focus back to the opener.
describe("useModalExit (mount-only modals)", () => {
  it("holds a closed request for the 200 ms fade with its last value, then lets it go", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ request }) => useModalExit(request), { initialProps: { request: { id: "a" } } });
    expect(result.current).toMatchObject({ shown: true, closing: false, state: undefined, value: { id: "a" } });
    rerender({ request: null });
    expect(result.current).toMatchObject({ shown: true, closing: true, state: "closing", value: { id: "a" } });
    act(() => { vi.advanceTimersByTime(200 + 33); });
    expect(result.current.shown).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toMatchObject({ shown: false, closing: false, value: null });
  });

  it("reopens mid-fade without unmounting, and closes in the same render under reduced motion", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ request }) => useModalExit(request), { initialProps: { request: false } });
    expect(result.current.shown).toBe(false);
    rerender({ request: true });
    expect(result.current).toMatchObject({ shown: true, closing: false });
    rerender({ request: false });
    expect(result.current.closing).toBe(true);
    rerender({ request: true });
    expect(result.current).toMatchObject({ shown: true, closing: false });
    reduceMotion(true);
    rerender({ request: false });
    expect(result.current).toMatchObject({ shown: false, closing: false });
  });
});

describe("useTransitionPresence fallbacks", () => {
  it("treats an unreadable motion query as motion allowed and runs on timers without animation frames", () => {
    vi.useFakeTimers();
    const raf = window.requestAnimationFrame;
    const caf = window.cancelAnimationFrame;
    window.matchMedia = () => { throw new Error("blocked"); };
    window.requestAnimationFrame = undefined;
    window.cancelAnimationFrame = undefined;
    try {
      const { result, rerender } = renderHook(({ open }) => useModalExit(open), { initialProps: { open: false } });
      rerender({ open: true });
      act(() => { vi.advanceTimersByTime(1); });
      rerender({ open: false });
      expect(result.current.closing).toBe(true);
      rerender({ open: true });
      expect(result.current.closing).toBe(false);
      rerender({ open: false });
      act(() => { vi.advanceTimersByTime(234); });
      expect(result.current.shown).toBe(false);
    } finally {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = caf;
    }
  });
});

describe("returnFocusAfterModal", () => {
  it("returns focus only when nothing else took it and the opener is still reachable", () => {
    const opener = document.createElement("button");
    const other = document.createElement("button");
    const fence = document.createElement("div");
    const fenced = document.createElement("button");
    fence.setAttribute("inert", "");
    fence.append(fenced);
    document.body.append(opener, other, fence);
    other.focus();
    expect(returnFocusAfterModal(opener)).toBe(false);
    expect(other).toHaveFocus();
    other.blur();
    expect(returnFocusAfterModal(fenced)).toBe(false);
    expect(returnFocusAfterModal(null)).toBe(false);
    expect(returnFocusAfterModal(opener)).toBe(true);
    expect(opener).toHaveFocus();
    opener.remove();
    expect(returnFocusAfterModal(opener)).toBe(false);
    other.remove();
    fence.remove();
  });
});

// Mirrors App: the opener sets the flag, useModalExit holds the overlay.
function OverlayHost({ kind, onClose = () => {}, onNavigate = () => {}, onStartTour = () => {} }) {
  const [open, setOpen] = useState(false);
  const exit = useModalExit(open);
  const close = () => { onClose(); setOpen(false); };
  return (
    <LanguageProvider lang="en">
      <button type="button" onClick={() => setOpen(true)}>Open overlay</button>
      {exit.shown && kind === "welcome" && <DemoWelcome memberName="Darnell Foster" closing={exit.closing} onTransitionEnd={exit.onTransitionEnd} onExplore={close} />}
      {exit.shown && kind === "guide" && <PreviewGuide closing={exit.closing} onTransitionEnd={exit.onTransitionEnd} onClose={close} onNavigate={onNavigate} onStartTour={onStartTour} />}
      {exit.shown && kind === "tour" && <GuidedTour closing={exit.closing} onTransitionEnd={exit.onTransitionEnd} onClose={close} onNavigate={onNavigate} />}
    </LanguageProvider>
  );
}

function openOverlay() {
  const opener = screen.getByRole("button", { name: "Open overlay" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const overlays = [
  ["the demo welcome", "welcome", ".demo-welcome-layer", "Explore on my own"],
  ["the preview guide", "guide", ".guide-dialog", "Close"],
  ["the guided tour", "tour", ".tour-layer", "Close guided tour"],
];

describe("the demo overlays close with the prototype modal's fade", () => {
  it.each(overlays)("%s stays for the 200 ms fade with focus inside, ignores a second dismissal, then hands focus back", (_name, kind, layerSelector, closeName) => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<OverlayHost kind={kind} onClose={onClose} />);
    const opener = openOverlay();
    const close = screen.getByRole("button", { name: closeName });
    close.focus();
    fireEvent.click(close);
    const layer = document.querySelector(layerSelector);
    expect(layer).toHaveAttribute("data-state", "closing");
    expect(close).toHaveFocus();
    fireEvent.click(close);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // A child's transition does not end the fade; the layer's own does.
    fireEvent.transitionEnd(close);
    expect(layer.isConnected).toBe(true);
    act(() => { vi.advanceTimersByTime(200 + 33); });
    expect(layer.isConnected).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(document.querySelector(layerSelector)).toBeNull();
    expect(opener).toHaveFocus();
  });

  it.each(overlays)("%s goes on its layer's transition end, and at once under reduced motion", (_name, kind, layerSelector) => {
    render(<OverlayHost kind={kind} />);
    const opener = openOverlay();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.transitionEnd(document.querySelector(layerSelector));
    expect(document.querySelector(layerSelector)).toBeNull();
    expect(opener).toHaveFocus();

    reduceMotion(true);
    openOverlay();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(layerSelector)).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("takes no further step from the guide or the tour mid-fade", () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const onStartTour = vi.fn();
    const { unmount } = render(<OverlayHost kind="guide" onNavigate={onNavigate} onStartTour={onStartTour} />);
    openOverlay();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /guided tour/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sam Okafor/ }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onStartTour).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Sam Okafor/ })).toHaveAttribute("aria-pressed", "false");
    unmount();

    render(<OverlayHost kind="tour" onNavigate={onNavigate} />);
    openOverlay();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
  });

  it("finishes the tour once, even when Finish is pressed again mid-fade", () => {
    vi.useFakeTimers();
    window.localStorage.clear();
    const onClose = vi.fn();
    render(<OverlayHost kind="tour" onClose={onClose} />);
    openOverlay();
    for (let step = 0; step < 5; step += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const finish = screen.getByRole("button", { name: "Finish tour" });
    fireEvent.click(finish);
    expect(document.querySelector(".tour-layer")).toHaveAttribute("data-state", "closing");
    fireEvent.click(finish);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(234); });
    expect(document.querySelector(".tour-layer")).toBeNull();
  });

  it("App holds the welcome, the guide and the tour through useModalExit", () => {
    const app = css("src/App.jsx");
    expect(app).toContain("const demoWelcomeExit = useModalExit(demoWelcomeOpen);");
    expect(app).toContain("const guideExit = useModalExit(guideOpen);");
    expect(app).toContain("const tourExit = useModalExit(tourOpen);");
    expect(app).toMatch(/\{demoWelcomeExit\.shown && \(\s*<DemoWelcome[\s\S]*?closing=\{demoWelcomeExit\.closing\}\s*onTransitionEnd=\{demoWelcomeExit\.onTransitionEnd\}/);
    expect(app).toContain("{guideExit.shown && <PreviewGuide closing={guideExit.closing} onTransitionEnd={guideExit.onTransitionEnd}");
    expect(app).toContain("{tourExit.shown && <GuidedTour closing={tourExit.closing} onTransitionEnd={tourExit.onTransitionEnd}");
    // The hat intro waits until the welcome has gone.
    expect(app).toContain("introduce={desktopShell && !demoWelcomeExit.shown}");
  });
});

describe("popups.css (the classic shell's popup and transition behaviour)", () => {
  const popups = css("src/popups.css");
  const rules = popups.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...rules.matchAll(/([^{}@;]+)\{[^{}]*\}/g)]
    .map((match) => match[1].trim())
    .filter((selector) => selector && !/^(from|to)$/.test(selector) && !/^\d/.test(selector));

  it("loads after motion.css and scopes every rule to the classic root, so the alternate shell is untouched", () => {
    const main = css("src/main.jsx");
    expect(main.indexOf('import "./popups.css";')).toBeGreaterThan(main.indexOf('import "./motion.css";'));
    const unscoped = selectors
      .flatMap(selectorParts)
      .filter((part) => !part.startsWith(".sg-app") && !part.startsWith(":root:has(.sg-app:not(.ugalt))"))
      .filter((part) => !/^\.desktop-rail__(tooltip|hat-menu)\b/.test(part) && part !== ".toast[data-leaving]");
    expect(unscoped).toEqual([]);
    expect(popups).not.toMatch(/!important/);
  });

  it("takes the prototype's scrim, settle, search drop, menu, toast and tooltip numbers", () => {
    expect(popups).toContain("--pop-scrim: rgba(13, 36, 30, .42);");
    // The dark appearance's scrim went with the dormant dark form.
    expect(popups).not.toContain("--pop-scrim: rgba(5, 14, 11, .62);");
    expect(popups).toContain("--pop-ease: cubic-bezier(.22, 1, .36, 1);");
    expect(rules).toMatch(/background: var\(--pop-scrim\);\s*-webkit-backdrop-filter: blur\(3px\);\s*backdrop-filter: blur\(3px\);/);
    expect(rules).toMatch(/\[data-state\] \{\s*opacity: 0;\s*transition: opacity \.2s ease;/);
    expect(rules).toMatch(/\.sg-detail-surface,[^{]*\.task-confirm \{\s*opacity: 1;\s*transform: translateY\(14px\) scale\(\.98\);[^}]*transition: transform \.28s var\(--pop-ease\);/);
    expect(popups).toContain("@keyframes pop-settle { from { transform: translateY(14px) scale(.98); } }");
    expect(popups).toContain(".sg-app:not(.ugalt) .command-palette__backdrop { padding-top: 12vh; }");
    expect(popups).toContain("@keyframes pop-drop { from { transform: translateY(-8px); } }");
    expect(popups).toContain(".sg-app:not(.ugalt) .command-palette__backdrop.ug-leaving { opacity: 0; transition: opacity .2s ease; }");
    expect(rules).toMatch(/opacity: 0;\s*transform: translateY\(-6px\);\s*transition: opacity \.18s cubic-bezier\(\.4, 0, \.2, 1\), transform \.18s cubic-bezier\(\.4, 0, \.2, 1\);/);
    expect(popups).toContain(".sg-app:not(.ugalt) .toast { animation: pop-toast-in .35s var(--pop-ease) backwards; }");
    expect(popups).toContain(".toast[data-leaving] { opacity: 0; transition: opacity .3s; }");
    expect(rules).toMatch(/translate: 0 4px;\s*transition: opacity \.12s, translate \.12s, visibility 0s linear \.12s;/);
  });

  it("swaps pages and Work views in place in the classic shell, as the prototype's router does", () => {
    const motion = css("src/motion.css");
    const ramp = motion.indexOf(".screen > * { animation: sg-rise");
    const off = motion.indexOf(":where(.sg-app:not(.ugalt)) .screen > * { animation: none; }");
    const overlays = motion.indexOf(".dialog-backdrop, .task-editor-backdrop, .kan-modal-backdrop { animation: sg-fade");
    expect(ramp).toBeGreaterThan(-1);
    expect(off).toBeGreaterThan(ramp);
    expect(overlays).toBeGreaterThan(off);
    expect(rules).toMatch(/\.sg-app:not\(\.ugalt\) \.kan-viewstage \{ animation: none; \}/);
    expect(rules).toContain(":root:has(.sg-app:not(.ugalt))::view-transition-new(kan-task-view)");
  });

  it("closes the mount-only modals with the scrim fade and the settle back out, in both shells", () => {
    expect(rules).toMatch(/:is\(\.dialog-backdrop, \.kan-modal-backdrop, \.cam-dialog-layer, \.demo-welcome-layer, \.tour-layer\):not\(\.sg-detail-layer\)\[data-state="closing"\] \{\s*opacity: 0;\s*transition: opacity \.2s ease;/);
    expect(rules).toMatch(/\[data-state="closing"\]:not\(\.sg-detail-layer\) > :is\(\.task-confirm, \.task-template-dialog, \.kan-shortcuts, \.cam-dialog, \.demo-welcome\) \{\s*transform: translateY\(14px\) scale\(\.98\);\s*transition: transform \.28s var\(--pop-ease\);/);
    expect(rules).toMatch(/\.tour-layer\[data-state="closing"\] > \.tour-dialog \{\s*transform: translate\(-50%, 14px\) scale\(\.98\);/);
    expect(rules).toMatch(/\.guide-dialog\[data-state="closing"\] \{\s*opacity: 0;\s*transform: translateY\(14px\) scale\(\.98\);\s*transition: opacity \.2s ease, transform \.28s var\(--pop-ease\);/);
    const alt = css("src/alt/styles/popups.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(alt).toMatch(/\.ugalt :is\(\.dialog-backdrop, \.task-template-backdrop, \.kan-modal-backdrop, \.cam-dialog-layer, \.demo-welcome-layer, \.tour-layer\):not\(\.sg-detail-layer\)\[data-state="closing"\] \{\s*opacity: 0;\s*transition: opacity \.2s ease;/);
    expect(alt).toMatch(/\.ugalt \.guide-dialog\[data-state="closing"\] \{\s*opacity: 0;/);
    expect(alt).toMatch(/\.ugalt \.tour-layer\[data-state="closing"\] > \.tour-dialog \{\s*transform: translate\(-50%, 14px\) scale\(\.98\);/);
  });

  it("drops every resting offset and leaves every popup visible under reduced motion", () => {
    const reduce = popups.slice(popups.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toMatch(/\[data-state\] \{ opacity: 1; \}/);
    expect(reduce).toMatch(/\.sg-detail-surface,\s*\.sg-app:not\(\.ugalt\) \.task-editor-backdrop\[data-state\] \.task-confirm,\s*\.sg-app:not\(\.ugalt\) \.command-palette__backdrop\.ug-leaving \.command-palette \{ transform: none; \}/);
    expect(reduce).toMatch(/\.desktop-rail__hat-menu\[data-state\] \{ opacity: 1; transform: none; \}/);
    expect(reduce).toMatch(/\.chapter-rail__tooltip \{ translate: none; \}/);
    // The global guard in styles.css cancels every animation and transition here.
    expect(css("src/styles.css")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important;[^}]*transition: none !important; \}/);
  });
});
