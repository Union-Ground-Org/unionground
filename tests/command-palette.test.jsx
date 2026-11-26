import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CommandPalette, REMOTE_DEBOUNCE_MS } from "../src/components/CommandPalette.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// The 48px option row is a stylesheet contract, not a class name: jsdom never
// applies src/styles.css, so the row minimum is read from the base
// `.command-palette__option` rule itself (the `:hover` / `[aria-selected]`
// rules start with the same selector, hence the brace anchor).
const OPTION_RULE = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
  .match(/^\.command-palette__option\s*\{([^}]*)\}/m);

const commands = [
  { id: "today", label: "Home", iconName: "home", onSelect: vi.fn() },
  { id: "cases", label: "My cases", iconName: "cases", onSelect: vi.fn() },
];

// The palette fades its scrim for 200 ms before it unmounts, as the
// prototype's search does.
const paletteGone = () => waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

function renderPalette(props = {}, lang = "en") {
  return render(
    <LanguageProvider lang={lang}>
      <button type="button">Before</button>
      <CommandPalette commands={commands} searchResults={[]} {...props} />
    </LanguageProvider>,
  );
}

describe("CommandPalette", () => {
  it.each([
    ["right scrollbar", 195, 50, 2],
    ["bottom scrollbar", 50, 135, 2],
    ["left scrollbar in RTL", 15, 50, 20],
  ])("allows native mousedown on the %s", (_label, clientX, clientY, clientLeft) => {
    renderPalette();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const list = screen.getByRole("listbox");
    Object.defineProperties(list, {
      clientWidth: { configurable: true, value: 180 },
      clientHeight: { configurable: true, value: 100 },
      clientLeft: { configurable: true, value: clientLeft },
      clientTop: { configurable: true, value: 2 },
    });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, right: 210, bottom: 140, width: 200, height: 120 });
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX, clientY });
    fireEvent(list, event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps non-focusable palette text from releasing focus and consuming the underlying Escape", async () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox");
    input.focus();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("dialog").querySelector("kbd"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(input).toHaveFocus();
    const underlying = vi.fn();
    const onUnderlyingKey = (event) => { if (!event.defaultPrevented) underlying(event); };
    window.addEventListener("keydown", onUnderlyingKey);
    try {
      fireEvent.keyDown(input, { key: "Escape" });
      await paletteGone();
      expect(underlying).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onUnderlyingKey);
    }
  });

  it("opens globally with Cmd/Ctrl+K and returns focus on Escape", async () => {
    const onOpen = vi.fn(async () => {});
    renderPalette({ onOpen });
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    expect(screen.getByRole("combobox", { name: "Search commands" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await paletteGone();
    await waitFor(() => expect(before).toHaveFocus());
  });

  it("keeps shell commands available when prerequisite hydration fails", async () => {
    renderPalette({ onOpen: vi.fn(async () => { throw new Error("search unavailable"); }) });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    // Wait for the failure to settle: before this alert appears the palette is
    // still in its pre-hydration state, so the rows below prove nothing.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Search results could not refresh. Commands are still available.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Home/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /My cases/ })).toBeInTheDocument();
  });

  it("filters, moves with arrows, and activates the selected real command", async () => {
    const onSelect = vi.fn();
    renderPalette({ commands: [{ id: "cases", label: "My cases", onSelect }] });
    screen.getByRole("button", { name: "Before" }).focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cases" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledOnce();
    await paletteGone();
    await waitFor(() => expect(screen.getByRole("button", { name: "Before" })).toHaveFocus());
  });

  it("restores focus after mouse activation, treats nullish selection as a no-op, and preserves destination focus", async () => {
    const destination = document.createElement("input");
    document.body.append(destination);
    const onSelect = vi.fn(() => destination.focus());
    renderPalette({ commands: [{ id: "destination", label: "Destination", onSelect }] });
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("option", { name: "Destination" }));
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(destination).toHaveFocus());

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "nothing" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    destination.remove();
  });

  it("A11Y-UG-COMMAND-PALETTE-ACTIVATION-FOCUS-20260907 returns focus after a click with no destination handoff", async () => {
    const onSelect = vi.fn();
    renderPalette({ commands: [{ id: "quiet", label: "Quiet command", onSelect }] });
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("option", { name: "Quiet command" }));

    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(before).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("renders empty state, bilingual copy, and 48px result rows", () => {
    renderPalette({}, "es");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No hay resultados.")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getAllByRole("option")[0]).toHaveClass("command-palette__option");

    expect(OPTION_RULE).not.toBeNull();
    const minHeight = OPTION_RULE[1].match(/(?:^|;)\s*min-height\s*:\s*([\d.]+)px/);
    expect(minHeight).not.toBeNull();
    expect(Number.parseFloat(minHeight[1])).toBeGreaterThanOrEqual(48);
  });

  it("asks the remote resolver after debounce and prefers those rows", async () => {
    const onSelect = vi.fn();
    const resolveRemoteResults = vi.fn(async () => [{
      id: "result:case:server-1",
      label: "SG-9 · Assigned overtime case",
      onSelect,
    }]);
    renderPalette({ resolveRemoteResults });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "overtime" } });
    expect(resolveRemoteResults).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Searching issues…");
    await waitFor(() => expect(resolveRemoteResults).toHaveBeenCalledWith(
      "overtime",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ), { timeout: REMOTE_DEBOUNCE_MS + 500 });
    const option = await screen.findByRole("option", { name: /Assigned overtime case/ });
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps one row when the server returns a result the local index also found", async () => {
    const resolveRemoteResults = vi.fn(async () => [{ id: "result:case:1", label: "Server overtime case", onSelect: vi.fn() }]);
    const resolveSearchResults = () => [
      { id: "result:case:1", label: "Local overtime case", onSelect: vi.fn() },
      { id: "result:case:2", label: "Local only case", onSelect: vi.fn() },
    ];
    renderPalette({ commands: [], resolveRemoteResults, resolveSearchResults });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "overtime" } });
    await screen.findByRole("option", { name: "Server overtime case" }, { timeout: REMOTE_DEBOUNCE_MS + 500 });
    expect(screen.queryByRole("option", { name: "Local overtime case" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Server overtime case", "Local only case"]);
  });

  it("closes on a backdrop press but not on a press inside the palette", async () => {
    renderPalette();
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    fireEvent.mouseDown(palette);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.mouseDown(palette.parentElement);
    await paletteGone();
    await waitFor(() => expect(before).toHaveFocus());
  });

  it("withholds No results while a remote search is still pending", async () => {
    let resolveSearch = () => {};
    const pending = new Promise((resolve) => { resolveSearch = resolve; });
    const resolveRemoteResults = vi.fn(() => pending);
    renderPalette({ resolveRemoteResults });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "overtime" } });

    expect(await screen.findByRole("status")).toHaveTextContent("Searching issues…");
    expect(screen.queryByText("No results.")).not.toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    await waitFor(() => expect(resolveRemoteResults).toHaveBeenCalledOnce(), { timeout: REMOTE_DEBOUNCE_MS + 500 });
    expect(screen.queryByText("No results.")).not.toBeInTheDocument();
    const pendingList = document.getElementById("command-palette-list");
    expect(pendingList?.querySelector("p")).toBeNull();
    for (const child of pendingList?.children ?? []) {
      expect(child.getAttribute("role")).toBe("option");
    }

    resolveSearch([]);
    const empty = await screen.findByText("No results.");
    // The verdict is announced in the same polite region that read out the
    // search, and that region stays outside the listbox.
    expect(screen.getByRole("status")).toBe(empty);
    const settledList = document.getElementById("command-palette-list");
    expect(settledList?.contains(empty) ?? false).toBe(false);
    for (const child of settledList?.children ?? []) {
      expect(child.getAttribute("role")).toBe("option");
    }
  });

  it("withholds No results while command loading is still pending", async () => {
    let finish = () => {};
    const pending = new Promise((resolve) => { finish = resolve; });
    const onOpen = vi.fn(() => pending);
    renderPalette({ commands: [], onOpen });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByRole("status")).toHaveTextContent("Loading search results…");
    expect(screen.queryByText("No results.")).not.toBeInTheDocument();
    expect(document.getElementById("command-palette-list")?.querySelector("p")).toBeNull();

    finish();
    const empty = await screen.findByText("No results.");
    expect(screen.getByRole("status")).toBe(empty);
    expect(document.getElementById("command-palette-list")?.contains(empty) ?? false).toBe(false);
  });

  it("keeps local commands when remote case search fails", async () => {
    const resolveRemoteResults = vi.fn(async () => { throw new Error("search unavailable"); });
    renderPalette({ resolveRemoteResults });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cases" } });
    await waitFor(() => expect(resolveRemoteResults).toHaveBeenCalled(), { timeout: REMOTE_DEBOUNCE_MS + 500 });
    expect(screen.getByRole("option", { name: /My cases/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("A11Y-UG-COMMAND-PALETTE-ACTIVE-OPTION-OFFSCREEN-20260920 keeps the keyboard-active option inside the list viewport", async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const many = Array.from({ length: 24 }, (_, index) => ({
      id: `cmd-${index}`,
      label: `Command ${index}`,
      onSelect: vi.fn(),
    }));

    function expectActive(combobox, command) {
      const option = screen.getByRole("option", { name: command.label });
      expect(option).toHaveAttribute("aria-selected", "true");
      expect(combobox).toHaveAttribute("aria-activedescendant", `command-option-${command.id}`);
      expect(document.activeElement).toBe(combobox);
      return option;
    }

    function expectRevealed(option) {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.instances.at(-1)).toBe(option);
    }

    try {
      renderPalette({ commands: many });
      const before = screen.getByRole("button", { name: "Before" });
      before.focus();
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      const combobox = screen.getByRole("combobox", { name: "Search commands" });
      expect(combobox).toHaveFocus();

      const list = document.getElementById("command-palette-list");
      Object.defineProperty(list, "clientHeight", { configurable: true, value: 288 });
      list.scrollTop = 0;

      scrollIntoView.mockClear();
      fireEvent.keyDown(combobox, { key: "End" });
      expectRevealed(expectActive(combobox, many[23]));

      scrollIntoView.mockClear();
      fireEvent.keyDown(combobox, { key: "Home" });
      expectRevealed(expectActive(combobox, many[0]));

      scrollIntoView.mockClear();
      fireEvent.keyDown(combobox, { key: "ArrowUp" });
      expectRevealed(expectActive(combobox, many[23]));

      scrollIntoView.mockClear();
      fireEvent.keyDown(combobox, { key: "ArrowDown" });
      expectRevealed(expectActive(combobox, many[0]));

      list.scrollTop = 0;
      const unchanged = list.scrollTop;
      fireEvent.keyDown(combobox, { key: "ArrowDown" });
      expectActive(combobox, many[1]);
      expect(list.scrollTop).toBe(unchanged);

      fireEvent.mouseMove(screen.getByRole("option", { name: "Command 5" }));
      expectActive(combobox, many[5]);
      fireEvent.keyDown(combobox, { key: "Enter" });
      expect(many[5].onSelect).toHaveBeenCalledOnce();
      await paletteGone();
      await waitFor(() => expect(before).toHaveFocus());

      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.keyDown(window, { key: "Escape" });
      await paletteGone();
      await waitFor(() => expect(before).toHaveFocus());

      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
      expect(screen.getByText("No results.")).toBeInTheDocument();
      expect(screen.getByRole("combobox")).toHaveFocus();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  describe("A11Y-UG-COMMAND-PALETTE-DIALOG-LAYER-AND-KEY-SCOPE-20261013", () => {
    it("announces an empty search through one polite status mounted with the palette, in English and Spanish", () => {
      for (const [lang, empty] of [["en", "No results."], ["es", "No hay resultados."]]) {
        const { unmount } = renderPalette({}, lang);
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        const status = screen.getByRole("status");
        expect(status).toHaveAttribute("aria-live", "polite");
        expect(status).toHaveTextContent("");
        const input = screen.getByRole("combobox");
        fireEvent.change(input, { target: { value: "zzz" } });
        expect(screen.getByRole("status")).toBe(status);
        expect(status).toHaveTextContent(empty);
        expect(screen.getByRole("listbox").contains(status)).toBe(false);
        fireEvent.change(input, { target: { value: "" } });
        expect(screen.getByRole("status")).toBe(status);
        expect(status).toHaveTextContent("");
        unmount();
      }
    });

    it("does not announce No results when hydration failed", async () => {
      renderPalette({ onOpen: vi.fn(async () => { throw new Error("search unavailable"); }) });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      await screen.findByRole("alert");
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
      expect(screen.getByRole("status")).toHaveTextContent("");
      expect(screen.queryByText("No results.")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Search results could not refresh.");
    });

    it("keeps options out of the Tab order and wraps Tab between real tab stops", async () => {
      renderPalette({ onOpen: vi.fn(async () => { throw new Error("search unavailable"); }) });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      for (const option of screen.getAllByRole("option")) expect(option).toHaveAttribute("tabindex", "-1");
      const retry = await screen.findByRole("button", { name: "Try again" });
      const input = screen.getByRole("combobox");
      retry.focus();
      // Try again is the last real tab stop; the options after it are not.
      expect(fireEvent.keyDown(retry, { key: "Tab" })).toBe(false);
      expect(input).toHaveFocus();
      expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(false);
      expect(retry).toHaveFocus();
      // A pressed result can keep focus without being a tab stop; Tab from it
      // returns to search instead of leaving the palette.
      const option = screen.getAllByRole("option")[0];
      option.focus();
      expect(fireEvent.keyDown(option, { key: "Tab" })).toBe(false);
      expect(input).toHaveFocus();
      option.focus();
      expect(fireEvent.keyDown(option, { key: "Tab", shiftKey: true })).toBe(false);
      expect(retry).toHaveFocus();
    });

    it("keeps the selection inside the list when results shrink", () => {
      const three = ["One", "Two", "Three"].map((label) => ({ id: label, label, onSelect: vi.fn() }));
      const { rerender } = renderPalette({ commands: three });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "End" });
      expect(screen.getByRole("option", { name: "Three" })).toHaveAttribute("aria-selected", "true");
      rerender(
        <LanguageProvider lang="en">
          <button type="button">Before</button>
          <CommandPalette commands={three.slice(0, 1)} searchResults={[]} />
        </LanguageProvider>,
      );
      const combobox = screen.getByRole("combobox");
      expect(screen.getByRole("option", { name: "One" })).toHaveAttribute("aria-selected", "true");
      expect(combobox).toHaveAttribute("aria-activedescendant", "command-option-One");
      fireEvent.keyDown(combobox, { key: "Enter" });
      expect(three[0].onSelect).toHaveBeenCalledOnce();
    });

    it("announces loading, searching and No results from the same polite node, in English and Spanish", async () => {
      for (const [lang, loading, empty] of [["en", "Loading search results…", "No results."], ["es", null, "No hay resultados."]]) {
        let finish = () => {};
        const onOpen = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
        const { unmount } = renderPalette({ commands: [], onOpen }, lang);
        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        const status = screen.getByRole("status");
        if (loading) expect(status).toHaveTextContent(loading);
        else expect(status.textContent).not.toBe("");
        await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
        finish();
        await waitFor(() => expect(status).toHaveTextContent(empty));
        expect(screen.getByRole("status")).toBe(status);
        expect(status).toHaveAttribute("aria-live", "polite");
        unmount();
      }
    });

    it("leaves Enter on a focused option or button to that control instead of choosing the active command", () => {
      const first = vi.fn();
      const second = vi.fn();
      renderPalette({ commands: [{ id: "a", label: "First", onSelect: first }, { id: "b", label: "Second", onSelect: second }] });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      const option = screen.getByRole("option", { name: "Second" });
      option.focus();
      expect(fireEvent.keyDown(option, { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(option, { key: "ArrowDown" })).toBe(true);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
      expect(screen.getByRole("option", { name: "First" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    });

    it("retries hydration from a focused Try again, keeps the palette open, and keeps focus in search", async () => {
      const onSelect = vi.fn();
      const onOpen = vi.fn()
        .mockRejectedValueOnce(new Error("search unavailable"))
        .mockResolvedValueOnce(undefined);
      renderPalette({ commands: [{ id: "home", label: "Home", onSelect }], onOpen });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      const retry = await screen.findByRole("button", { name: "Try again" });
      retry.focus();
      // jsdom does not synthesize the native click a real Enter produces; the
      // dialog handler must not prevent it, and the browser run proves the click.
      expect(fireEvent.keyDown(retry, { key: "Enter" })).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.click(retry);
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
      expect(screen.getByRole("combobox")).toHaveFocus();
    });
  });
});
