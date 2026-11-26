import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/CommandPalette.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

const command = (id) => ({ id, label: `Find ${id}`, onSelect: vi.fn() });
function openPalette() {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  return screen.getByRole("combobox");
}
const selected = () => screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true");

describe("command palette selection identity", () => {
  it.each(["keyboard", "pointer"])("keeps the %s-selected command when results arrive above it", (method) => {
    const first = command("first");
    const target = command("target");
    const inserted = command("late-officer");
    const view = render(<CommandPalette commands={[first, target]} />);
    const input = openPalette();
    if (method === "keyboard") fireEvent.keyDown(input, { key: "ArrowDown" });
    else fireEvent.mouseMove(screen.getByRole("option", { name: target.label }));
    expect(selected()).toBe(screen.getByRole("option", { name: target.label }));
    view.rerender(<CommandPalette commands={[inserted, first, target]} />);
    expect(selected()).toBe(screen.getByRole("option", { name: target.label }));
    expect(input.getAttribute("aria-activedescendant")).toBe(`command-option-${target.id}`);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(target.onSelect).toHaveBeenCalledOnce();
    expect(first.onSelect).not.toHaveBeenCalled();
    expect(inserted.onSelect).not.toHaveBeenCalled();
  });

  it("keeps a selected local result when a debounced server result is inserted above it", async () => {
    const target = command("local-case");
    const incoming = command("server-case");
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const resolveRemoteResults = vi.fn(() => pending);
    render(<CommandPalette commands={[]} searchResults={[target]} resolveRemoteResults={resolveRemoteResults} />);
    const input = openPalette();
    fireEvent.change(input, { target: { value: "find" } });
    await waitFor(() => expect(resolveRemoteResults).toHaveBeenCalledOnce());
    expect(selected()).toBe(screen.getByRole("option", { name: target.label }));
    await act(async () => { release([incoming]); await pending; });
    expect(selected()).toBe(screen.getByRole("option", { name: target.label }));
    expect(input).toBe(screen.getByRole("combobox"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(target.onSelect).toHaveBeenCalledOnce();
    expect(incoming.onSelect).not.toHaveBeenCalled();
  });

  // #9565 B-32: the palette opens over a resting pointer, and the row that
  // appears under it took the selection (the eighth row on open). Only a
  // pointer that moves picks a row.
  it("selects the first row on open even when a row appears under a resting pointer, and follows a moving pointer", () => {
    const commands = Array.from({ length: 10 }, (_, index) => command(`row-${index + 1}`));
    render(<CommandPalette commands={commands} />);
    const input = openPalette();
    const eighth = screen.getByRole("option", { name: commands[7].label });
    fireEvent.mouseEnter(eighth);
    fireEvent.mouseOver(eighth);
    expect(selected()).toBe(screen.getByRole("option", { name: commands[0].label }));
    expect(input.getAttribute("aria-activedescendant")).toBe(`command-option-${commands[0].id}`);
    fireEvent.mouseMove(eighth);
    expect(selected()).toBe(eighth);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commands[7].onSelect).toHaveBeenCalledOnce();
  });

  it("resets to the first matching command when the query changes", () => {
    const first = command("first");
    const target = command("target");
    render(<CommandPalette commands={[first, target]} />);
    const input = openPalette();
    fireEvent.keyDown(input, { key: "End" });
    expect(selected()).toBe(screen.getByRole("option", { name: target.label }));
    fireEvent.change(input, { target: { value: "find" } });
    expect(selected()).toBe(screen.getByRole("option", { name: first.label }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(first.onSelect).toHaveBeenCalledOnce();
    expect(target.onSelect).not.toHaveBeenCalled();
  });

  it("falls back to the first visible command when the selection is removed", () => {
    const first = command("first");
    const target = command("target");
    const last = command("last");
    const view = render(<CommandPalette commands={[first, target, last]} />);
    const input = openPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    view.rerender(<CommandPalette commands={[first, last]} />);
    expect(selected()).toBe(screen.getByRole("option", { name: first.label }));
    view.rerender(<CommandPalette commands={[first, target, last]} />);
    expect(selected()).toBe(screen.getByRole("option", { name: first.label }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(first.onSelect).toHaveBeenCalledOnce();
    expect(target.onSelect).not.toHaveBeenCalled();
    expect(last.onSelect).not.toHaveBeenCalled();
  });
});
