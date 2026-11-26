import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AltShellContext } from "../src/alt/altShellContext.js";
import { PALETTE_CLOSE_FADE_MS, CommandPalette } from "../src/components/CommandPalette.jsx";
import { Dialog } from "../src/components/Dialog.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// an owner decision for the two production popups both shells
// share. The Dialog opens on its [autofocus] field or its close button and
// keeps focus while its scrim fades out, and the command palette fades its
// scrim for 200 ms before it unmounts (core.js UG.modal). The alternate shell
// took this first (#6614); the classic shell adopts the same behaviour
// (REQ-UG-CLASSIC-SHELL-POPUPS-TRANSITIONS-MATCH-PROTOTYPE-20261030).

const realMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

function DialogHost({ alt = false, children = null }) {
  const [open, setOpen] = useState(false);
  const tree = (
    <>
      <button type="button" onClick={() => setOpen(true)}>opener</button>
      {open ? <Dialog title="Notifications" onClose={() => setOpen(false)}>{children ?? <button type="button">Mark all read</button>}</Dialog> : null}
    </>
  );
  return <LanguageProvider lang="en">{alt ? <AltShellContext.Provider value={{ openRail: null }}>{tree}</AltShellContext.Provider> : tree}</LanguageProvider>;
}

function openDialog() {
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe.each([["classic", false], ["alternate", true]])("Dialog's first focus and close in the %s shell", (_name, alt) => {
  it("opens on its close button, keeps focus inside while the scrim fades, then returns it", async () => {
    render(<DialogHost alt={alt} />);
    const opener = openDialog();
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    const backdrop = document.querySelector(".dialog-backdrop");
    fireEvent.click(close);
    expect(backdrop).toHaveAttribute("data-state", "closing");
    expect(backdrop).not.toHaveAttribute("inert");
    expect(backdrop).not.toHaveAttribute("aria-hidden");
    expect(close).toHaveFocus();
    // Mid-fade the trap stands down, as the prototype's listener is gone.
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    close.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("opens on an [autofocus] field first, and leaves a field React already focused", async () => {
    const { unmount } = render(<DialogHost alt={alt}><label>Note<input ref={(node) => node?.setAttribute("autofocus", "")} /></label></DialogHost>);
    openDialog();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).toHaveFocus());
    unmount();
    render(<DialogHost alt={alt}><label>First<input /></label><label>Second<input autoFocus /></label></DialogHost>);
    openDialog();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Second" })).toHaveFocus());
  });
});

describe.each([["classic", false], ["alternate", true]])("a closing Dialog in the %s shell", (_name, alt) => {
  it("keeps focus inside but lets no child act during the fade (click, Enter, Space, submit)", async () => {
    const choose = vi.fn();
    const submit = vi.fn((event) => event.preventDefault());
    render(<DialogHost alt={alt}><form onSubmit={submit}><button type="submit" onClick={choose}>Cast my vote</button></form></DialogHost>);
    openDialog();
    const cast = screen.getByRole("button", { name: "Cast my vote" });
    cast.focus();
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector(".dialog-backdrop")).toHaveAttribute("data-state", "closing");
    cast.focus();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    cast.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const space = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    cast.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    fireEvent.click(cast);
    fireEvent.submit(cast.closest("form"));
    expect(choose).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
  });
});

describe.each([["classic", false], ["alternate", true]])("Dialog in the %s shell", (_name, alt) => {
  it("traps Tab, closes on Escape and on a press on the scrim", async () => {
    render(<DialogHost alt={alt}><button type="button">One</button><button type="button">Two</button></DialogHost>);
    openDialog();
    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    const close = screen.getByRole("button", { name: "Close" });
    const two = screen.getByRole("button", { name: "Two" });
    two.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(two).toHaveFocus();
    screen.getByRole("heading", { name: "Notifications" }).focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(two).toHaveFocus();
    // Focus that sits outside the surface comes back in at either end.
    const outside = document.querySelector(".dialog-backdrop");
    outside.tabIndex = -1;
    outside.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(two).toHaveFocus();
    outside.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    const one = screen.getByRole("button", { name: "One" });
    one.focus();
    const middle = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
    openDialog();
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
  });
});

describe("feedback when a guard keeps a dialog open", () => {
  it.each([
    ["en", "Close", "An action in this dialog blocked closing. Check its status and try again.", (_dialog, close) => fireEvent.click(close)],
    ["es", "Cerrar", "Una acción impidió cerrar este cuadro de diálogo. Revisa su estado e inténtalo de nuevo.", (dialog) => fireEvent.keyDown(dialog, { key: "Escape" })],
    ["en", "Close", "An action in this dialog blocked closing. Check its status and try again.", (dialog) => fireEvent.mouseDown(dialog.parentElement)],
  ])("explains a veto through each close control (%s)", async (lang, closeName, explanation, requestClose) => {
    const onClose = vi.fn();
    const beforeClose = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    render(<LanguageProvider lang={lang}><Dialog title="Request" beforeClose={beforeClose} onClose={onClose}><input aria-label="Details" defaultValue="Keep this draft" /></Dialog></LanguageProvider>);
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: closeName });
    const status = dialog.querySelector('[aria-live="polite"]');

    requestClose(dialog, close);
    const feedback = await within(dialog).findByText(explanation, {}, { timeout: 500 });
    expect(feedback).toBe(status);
    expect(close).toHaveAccessibleDescription(explanation);
    expect(within(dialog).getByRole("textbox")).toHaveValue("Keep this draft");
    expect(onClose).not.toHaveBeenCalled();

    requestClose(dialog, close);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(beforeClose).toHaveBeenCalledTimes(2);
  });

  it("clears a veto when the action settles or the mounted dialog gets a new operation", async () => {
    const onClose = vi.fn();
    const beforeClose = vi.fn().mockReturnValue(false);
    const view = (blocked, operation) => (
      <LanguageProvider lang="en">
        <Dialog title="Request" beforeClose={beforeClose} onClose={onClose} closeBlocked={blocked} closeOperationKey={operation} />
      </LanguageProvider>
    );
    const { rerender } = render(view(true, "first"));
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "Close" });
    const status = dialog.querySelector('[aria-live="polite"]');

    fireEvent.click(close);
    await waitFor(() => expect(status).toHaveTextContent(/blocked closing/));
    rerender(view(false, "first"));
    expect(status).toBeEmptyDOMElement();
    expect(close).not.toHaveAttribute("aria-describedby");

    rerender(view(true, "first"));
    expect(status).toBeEmptyDOMElement();
    fireEvent.click(close);
    await waitFor(() => expect(status).toHaveTextContent(/blocked closing/));
    rerender(view(true, "second"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(status).toBeEmptyDOMElement();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows that an asynchronous close check is pending, then gives a retry after rejection", async () => {
    let reject;
    const pending = new Promise((_resolve, fail) => { reject = fail; });
    const onClose = vi.fn();
    const beforeClose = vi.fn().mockReturnValueOnce(pending).mockReturnValue(true);
    render(<LanguageProvider lang="en"><Dialog title="Request" beforeClose={beforeClose} onClose={onClose} /></LanguageProvider>);
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "Close" });
    fireEvent.click(close);
    const feedback = await within(dialog).findByText("Checking whether this dialog can close…", {}, { timeout: 500 });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(beforeClose).toHaveBeenCalledTimes(1);

    await act(async () => reject(new Error("close check failed")));
    expect(feedback).toHaveTextContent("Couldn't check whether this dialog can close. Try again.");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(close);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

const commands = [
  { id: "today", label: "Home", onSelect: vi.fn() },
  { id: "cases", label: "My cases", onSelect: vi.fn() },
];

function renderPalette({ alt = false, reduce = false } = {}) {
  window.matchMedia = vi.fn((query) => ({ matches: reduce && query.includes("reduced-motion"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  const palette = <><button type="button">Before</button><CommandPalette commands={commands} searchResults={[]} /></>;
  render(<LanguageProvider lang="en">{alt ? <div className="ugalt">{palette}</div> : palette}</LanguageProvider>);
  const before = screen.getByRole("button", { name: "Before" });
  before.focus();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  return { before, input: screen.getByRole("combobox") };
}

describe.each([["classic", false], ["alternate", true]])("CommandPalette close in the %s shell", (_name, alt) => {
  it("fades the scrim for 200 ms, focus held inside, then unmounts and returns focus", () => {
    vi.useFakeTimers();
    const { before, input } = renderPalette({ alt });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    const backdrop = document.querySelector(".command-palette__backdrop");
    expect(backdrop).toHaveClass("ug-leaving");
    expect(backdrop).not.toHaveAttribute("inert");
    expect(input).toHaveFocus();
    // A second dismissal (the scrim, Ctrl+K) during the fade changes nothing.
    fireEvent.mouseDown(backdrop);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    act(() => { vi.advanceTimersByTime(PALETTE_CLOSE_FADE_MS - 1); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(before).toHaveFocus();
    expect(PALETTE_CLOSE_FADE_MS).toBe(200);
  });

  it("releases the page at once when a command is chosen, while the scrim still fades", () => {
    vi.useFakeTimers();
    const { before, input } = renderPalette({ alt });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commands[0].onSelect).toHaveBeenCalled();
    const backdrop = document.querySelector(".command-palette__backdrop");
    expect(backdrop).toHaveClass("ug-leaving");
    expect(backdrop).toHaveAttribute("inert");
    act(() => { vi.advanceTimersByTime(1); });
    expect(before).toHaveFocus();
    act(() => { vi.advanceTimersByTime(PALETTE_CLOSE_FADE_MS); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(before).toHaveFocus();
  });

  it("runs no command and holds the search while the dismissal fades", () => {
    // Refs #5710, comment 6539652105: close() returned early but choose() still ran the command.
    vi.useFakeTimers();
    commands.forEach((command) => command.onSelect.mockClear());
    const { input } = renderPalette({ alt });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector(".command-palette__backdrop")).toHaveClass("ug-leaving");
    expect(input).toHaveAttribute("readonly");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getAllByRole("option")[0]);
    act(() => { vi.advanceTimersByTime(PALETTE_CLOSE_FADE_MS); });
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const command of commands) expect(command.onSelect).not.toHaveBeenCalled();
  });

  it("closes at once when reduced motion is asked for", () => {
    vi.useFakeTimers();
    const { before, input } = renderPalette({ alt, reduce: true });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".ug-leaving")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(before).toHaveFocus();
  });
});
