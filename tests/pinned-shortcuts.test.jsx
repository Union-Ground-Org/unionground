import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NavGlyph } from "../src/components/NavGlyphs.jsx";
import { PinnedShortcuts } from "../src/components/PinnedShortcuts.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

function Harness({ initial = [], lang = "en", hasStewardRole = false, onNavigate = vi.fn(), onAsk = vi.fn(), onChange = vi.fn() }) {
  const [keys, setKeys] = useState(initial);
  return (
    <LanguageProvider lang={lang}>
      <PinnedShortcuts
        keys={keys}
        hasStewardRole={hasStewardRole}
        onChange={(next) => { onChange(next); setKeys(next); }}
        onNavigate={onNavigate}
        onAsk={onAsk}
      />
    </LanguageProvider>
  );
}

describe("Pinned shortcuts", () => {
  it("renders six backed member defaults in a labeled in-card navigation", () => {
    render(<Harness />);
    const nav = screen.getByRole("navigation", { name: "Pinned shortcuts" });
    expect(within(nav).getAllByRole("link")).toHaveLength(5);
    expect(within(nav).getByRole("button", { name: "Union Ground Guide" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/m");
    expect(screen.getByRole("button", { name: "Customize" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Compass" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Find my committee contact" })).toBeInTheDocument();
    expect(within(nav).queryByText(/steward/i)).toBeNull();
  });

  it("edits complete arrays with a one-item floor and six-item ceiling", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    const dialog = screen.getByRole("dialog", { name: "Customize pinned shortcuts" });
    expect(within(dialog).getAllByRole("button", { name: /^Add / }).every((button) => button.disabled)).toBe(true);
    // Any member default serves to exercise the floor and ceiling. This one
    // names Voting (Voice until #9527) rather than My reports since 2026-09-22, when Find my committee contact
    // took the sixth default slot from Reports.
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Voting" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Meetings" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move Meetings up" }));
    const latest = onChange.mock.calls.at(-1)[0];
    expect(latest).toHaveLength(6);
    expect(latest).toContain("events");
    expect(latest).not.toContain("voting");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    expect(screen.getByRole("button", { name: "Customize" })).toHaveFocus();
  });

  it("never lets the member remove the final shortcut", () => {
    render(<Harness initial={["cases"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByRole("button", { name: "Remove My issues" })).toBeDisabled();
  });

  it("routes backed tiles and opens the Guide as an action", () => {
    const onNavigate = vi.fn();
    const onAsk = vi.fn();
    render(<Harness initial={["cases", "compass"]} onNavigate={onNavigate} onAsk={onAsk} />);
    fireEvent.click(screen.getByRole("link", { name: "My issues" }));
    expect(onNavigate).toHaveBeenCalledWith("cases", "/m/cases");
    fireEvent.click(screen.getByRole("button", { name: "Union Ground Guide" }));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("draws Home and Organization network with their own glyphs, not the neutral one", () => {
    render(<Harness initial={["today", "network", "cases"]} />);
    const nav = screen.getByRole("navigation", { name: "Pinned shortcuts" });
    const glyphOf = (name) =>
      within(nav).getByRole("link", { name }).querySelector(".nav-glyph path").getAttribute("d");
    const { container } = render(<NavGlyph name="a-key-with-no-glyph" />);
    const neutral = container.querySelector(".nav-glyph path").getAttribute("d");

    expect(neutral).toBeTruthy();
    expect(glyphOf("My issues")).not.toBe(neutral);
    expect(glyphOf("Home")).not.toBe(neutral);
    expect(glyphOf("Organization network")).not.toBe(neutral);
    expect(glyphOf("Home")).not.toBe(glyphOf("Organization network"));
  });

  it("renders the steward persona defaults when the member has no saved shortcuts", () => {
    render(<Harness hasStewardRole />);
    const nav = screen.getByRole("navigation", { name: "Pinned shortcuts" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Home",
      "My issues",
      "Messages",
      "My reports",
      "Settings",
    ]);
    expect(within(nav).getByRole("button", { name: "Union Ground Guide" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Voting" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Know your rights" })).not.toBeInTheDocument();
  });

  it("seeds the editor and the saved array from the steward defaults", () => {
    const onChange = vi.fn();
    render(<Harness hasStewardRole onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    const dialog = screen.getByRole("dialog", { name: "Customize pinned shortcuts" });
    expect(within(dialog).getByRole("button", { name: "Remove My issues" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add Voting" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Messages" }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual(["today", "cases", "numbers", "compass", "settings"]);
  });

  it("localizes the section and editor controls in Spanish", () => {
    render(<Harness initial={["cases"]} lang="es" />);
    expect(screen.getByRole("navigation", { name: "Atajos fijados" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    expect(screen.getByRole("dialog", { name: "Personalizar atajos fijados" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar Mis asuntos" })).toBeDisabled();
  });

  it("keeps focus on an enabled editor control and announces adds, removes and edge reorders", () => {
    const onChange = vi.fn();
    render(<Harness initial={["today", "numbers", "voting"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    const dialog = screen.getByRole("dialog", { name: "Customize pinned shortcuts" });
    const live = dialog.querySelector("[aria-live='polite']");

    within(dialog).getByRole("button", { name: "Remove My reports" }).focus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove My reports" }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual(["today", "voting"]);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Add My reports" }));
    expect(live).toHaveTextContent("My reports removed from pinned shortcuts");

    fireEvent.click(within(dialog).getByRole("button", { name: "Add Meetings" }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual(["today", "voting", "events"]);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Remove Meetings" }));
    expect(live).toHaveTextContent("Meetings added to pinned shortcuts");

    within(dialog).getByRole("button", { name: "Move Voting up" }).focus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move Voting up" }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual(["voting", "today", "events"]);
    expect(within(dialog).getByRole("button", { name: "Move Voting up" })).toBeDisabled();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Move Voting down" }));
    expect(live).toHaveTextContent("Voting moved to position 1 of 3");

    fireEvent.click(within(dialog).getByRole("button", { name: "Move Home down" }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual(["voting", "events", "today"]);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Move Home up" }));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("announces adds and removes in Spanish", () => {
    render(<Harness initial={["today", "numbers"]} lang="es" />);
    fireEvent.click(screen.getByRole("button", { name: "Personalizar" }));
    const dialog = screen.getByRole("dialog", { name: "Personalizar atajos fijados" });
    const live = dialog.querySelector("[aria-live='polite']");
    fireEvent.click(within(dialog).getByRole("button", { name: "Quitar Mis informes" }));
    expect(live).toHaveTextContent("Mis informes se quitó de los atajos fijados");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Añadir Mis informes" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Añadir Mis informes" }));
    expect(live).toHaveTextContent("Mis informes se añadió a los atajos fijados");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Quitar Mis informes" }));
  });

  it("leaves modified and non-primary tile clicks to the browser and still opens the Guide", () => {
    const onNavigate = vi.fn();
    const onAsk = vi.fn();
    render(<Harness onNavigate={onNavigate} onAsk={onAsk} />);
    const nav = screen.getByRole("navigation", { name: "Pinned shortcuts" });
    const home = within(nav).getByRole("link", { name: "Home" });
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      // fireEvent returns false only when a handler prevented the default.
      expect(fireEvent.click(home, init)).toBe(true);
    }
    expect(onNavigate).not.toHaveBeenCalled();
    expect(fireEvent.click(home)).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith("today", "/m");
    fireEvent.click(within(nav).getByRole("button", { name: "Union Ground Guide" }), { ctrlKey: true });
    expect(onAsk).toHaveBeenCalledTimes(1);
  });
});
