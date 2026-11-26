import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe("app command navigation", () => {
  it("opens the palette and activates a real route result", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "cases" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(window.location.pathname).toBe("/m/cases");
    // The palette's scrim fades for 200 ms before it unmounts.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());
  });

  it("uses slash for Search only outside editors and dialogs", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    const neutral = screen.getByRole("link", { name: "Home" });
    neutral.focus();
    fireEvent.keyDown(neutral, { key: "/" });
    await waitFor(() => expect(window.location.pathname).toBe("/m/search"));
    expect(await screen.findByRole("searchbox", { name: "Search" })).toHaveFocus();

    window.history.replaceState({}, "", "/m");
    const editor = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.keyDown(editor, { key: "/" });
    expect(window.location.pathname).toBe("/m");
  });

  it("maps Ctrl/Command number shortcuts to visible rail positions", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    // Union Ground's worker rail puts the Work list beside Home, so it is
    // the second position and Voting the third.
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(window.location.pathname).toBe("/m/work");
    expect(screen.getByRole("link", { name: "Work" })).toHaveAttribute("aria-keyshortcuts", "Control+2 Meta+2");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(window.location.pathname).toBe("/m/voting");
    expect(screen.getByRole("link", { name: "Voting" })).toHaveAttribute("aria-keyshortcuts", "Control+3 Meta+3");
  });
});
