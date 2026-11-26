// REQ-UG-KEYBOARD-SHORTCUTS-OFF-BY-DEFAULT-20261103. Owner order,
// November 3, 2026: "toggle keyboard shortcuts as off by default. users can
// enable them in their settings". One member choice, off for every member,
// governs every application shortcut; Tab, Enter, Space, arrows and Escape
// never read it.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AltShell from "../src/alt/AltShell.jsx";
import { CommandPalette } from "../src/components/CommandPalette.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  keyboardShortcutsEnabled, keyboardShortcutsStorageKey, readKeyboardShortcuts, resetKeyboardShortcutsForTests,
  setKeyboardShortcutsEnabled, setKeyboardShortcutsScope, writeKeyboardShortcuts,
} from "../src/lib/keyboardShortcuts.js";
import { resetUnsavedCharacterShortcutChoices } from "../src/lib/taskCharacterShortcuts.js";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { TasksView } from "../src/views/TasksView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const inEnglish = (node) => <LanguageProvider lang="en">{node}</LanguageProvider>;
const OFF_HINT = "Keyboard shortcuts are off. Turn them on in Settings, under Keyboard shortcuts.";

beforeEach(() => {
  resetKeyboardShortcutsForTests();
  resetUnsavedCharacterShortcutChoices();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/m");
});
afterEach(() => {
  resetKeyboardShortcutsForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("the Keyboard shortcuts choice", () => {
  it("is off for a fresh member, a member with nothing stored and no member at all", () => {
    expect(keyboardShortcutsEnabled()).toBe(false);
    setKeyboardShortcutsScope(MEMBER);
    expect(keyboardShortcutsEnabled()).toBe(false);
    setKeyboardShortcutsScope(MEMBER, true);
    expect(keyboardShortcutsEnabled()).toBe(false);
  });

  it("follows the member in localStorage and keeps the fixture demo's in sessionStorage", () => {
    expect(keyboardShortcutsStorageKey(MEMBER)).toBe(`sg:member:${MEMBER}:keyboard-shortcuts`);
    expect(keyboardShortcutsStorageKey(MEMBER, true)).toBe("sg:demo:keyboard-shortcuts");
    expect(keyboardShortcutsStorageKey(null)).toBeNull();

    setKeyboardShortcutsScope(MEMBER);
    expect(setKeyboardShortcutsEnabled(true)).toBe(true);
    expect(window.localStorage.getItem(`sg:member:${MEMBER}:keyboard-shortcuts`)).toBe("true");

    // The fixture visitor never writes the shared fixture member's row.
    setKeyboardShortcutsScope(MEMBER, true);
    expect(keyboardShortcutsEnabled()).toBe(false);
    setKeyboardShortcutsEnabled(true);
    expect(window.sessionStorage.getItem("sg:demo:keyboard-shortcuts")).toBe("true");
    setKeyboardShortcutsEnabled(false);
    expect(window.localStorage.getItem(`sg:member:${MEMBER}:keyboard-shortcuts`)).toBe("true");
    expect(window.localStorage.getItem("sg:demo:keyboard-shortcuts")).toBeNull();

    // Another member reads their own choice.
    setKeyboardShortcutsScope("22222222-2222-4222-8222-222222222222");
    expect(keyboardShortcutsEnabled()).toBe(false);
  });

  it("remembers a refused write for the page load, over a stale saved value", () => {
    const key = keyboardShortcutsStorageKey(MEMBER);
    window.localStorage.setItem(key, "true");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      expect(writeKeyboardShortcuts(key, false, false)).toBe(false);
      expect(readKeyboardShortcuts(key)).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("shortcuts while the choice is off", () => {
  function renderRail(onNavigate) {
    return render(inEnglish(
      <DesktopRail
        active="today"
        activeHat="member"
        memberId="member-a"
        onAsk={() => {}}
        onNavigate={onNavigate}
        onNotifications={() => {}}
        onSwitchHat={() => {}}
        renderMode="desktop"
        staffPlanes={[]}
        user={{ name: "Darnell Foster", initials: "DF", onProfile: () => {} }}
      />,
    ));
  }

  it("leaves the rail number keys inert and unadvertised until the member turns them on", () => {
    setKeyboardShortcutsScope(MEMBER);
    const onNavigate = vi.fn();
    renderRail(onNavigate);
    const rail = document.querySelector(".desktop-rail");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rail.querySelector(".desktop-rail__shortcut")).toBeNull();
    expect(rail.querySelector("[aria-keyshortcuts]")).toBeNull();

    act(() => { setKeyboardShortcutsEnabled(true); });
    expect(rail.querySelector(".desktop-rail__shortcut")).toHaveAttribute("data-keys", "Ctrl+1");
    expect(rail.querySelector("[aria-keyshortcuts]")).toHaveAttribute("aria-keyshortcuts", "Control+1 Meta+1");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not open the command palette on Control+K or Command+K", () => {
    setKeyboardShortcutsScope(MEMBER);
    render(inEnglish(<CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();

    act(() => { setKeyboardShortcutsEnabled(true); });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("does not open the alternate shell's search on a bare / and hides its key hint", () => {
    setKeyboardShortcutsScope(MEMBER);
    const onSearch = vi.fn();
    render(inEnglish(
      <AltShell active="today" onNavigate={vi.fn()} onSearch={onSearch} user={{ initials: "DS", name: "Dana", onProfile: vi.fn() }}><p>page</p></AltShell>,
    ));
    const search = screen.getAllByRole("button", { name: "Search" })[0];
    expect(search.querySelector("kbd")).toBeNull();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onSearch).not.toHaveBeenCalled();

    act(() => { setKeyboardShortcutsEnabled(true); });
    expect(screen.getAllByRole("button", { name: "Search" })[0].querySelector("kbd")).toHaveTextContent("/");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onSearch).toHaveBeenCalledTimes(1);
  });
});

describe("the command palette's click entry points", () => {
  const palette = <CommandPalette commands={[{ id: "cases", label: "My cases", onSelect: vi.fn() }]} />;

  it("opens the palette from the desktop rail button with shortcuts off, advertising Control+K only when on", () => {
    setKeyboardShortcutsScope(MEMBER);
    render(inEnglish(
      <>
        <DesktopRail active="today" activeHat="steward" memberId="member-a" onNavigate={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]} />
        {palette}
      </>,
    ));
    const button = screen.getByRole("button", { name: "Command palette" });
    expect(button).not.toHaveAttribute("aria-keyshortcuts");
    expect(button.querySelector(".desktop-rail__shortcut")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /My cases/ })).toBeInTheDocument();
  });

  it("shows the Control+K hint on the rail button once shortcuts are on", () => {
    setKeyboardShortcutsScope(MEMBER);
    setKeyboardShortcutsEnabled(true);
    render(inEnglish(<DesktopRail active="today" activeHat="member" memberId="member-a" onNavigate={() => {}} onSwitchHat={() => {}} renderMode="desktop" staffPlanes={[]} />));
    const button = screen.getByRole("button", { name: "Command palette" });
    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
    expect(button.querySelector(".desktop-rail__shortcut")).toHaveAttribute("data-keys", "Ctrl+K");
  });

  it.each(["member", "steward"])("opens the palette from the alternate shell's side button on the %s hat with shortcuts off", (activeHat) => {
    setKeyboardShortcutsScope(MEMBER);
    render(inEnglish(
      <>
        <AltShell active="today" activeHat={activeHat} onNavigate={vi.fn()} onSearch={vi.fn()} user={{ initials: "DS", name: "Dana", onProfile: vi.fn() }}><p>page</p></AltShell>
        {palette}
      </>,
    ));
    const [button] = screen.getAllByRole("button", { name: "Command palette" });
    expect(button.querySelector("kbd")).toBeNull();
    expect(button).not.toHaveAttribute("aria-keyshortcuts");
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });
});

describe("the Settings switch", () => {
  const data = { member: { id: MEMBER, initials: "TM", fullName: "Test Member", firstName: "Test", notificationPrefs: {} }, roles: [], organizationConfiguration: null, events: [], forms: [] };

  it.each([["classic Settings", false], ["the alternate Account page", true]])("turns shortcuts on from %s", (_name, alt) => {
    setKeyboardShortcutsScope(MEMBER);
    window.history.replaceState({}, "", "/m/settings");
    render(inEnglish(<SettingsView alt={alt} data={data} lang="en" onLanguage={vi.fn()} />));
    const toggle = screen.getByRole("switch", { name: "Use keyboard shortcuts" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(keyboardShortcutsEnabled()).toBe(true);
    expect(window.localStorage.getItem(`sg:member:${MEMBER}:keyboard-shortcuts`)).toBe("true");
    fireEvent.click(toggle);
    expect(keyboardShortcutsEnabled()).toBe(false);
  });

  it("says when the browser could not save the choice", () => {
    setKeyboardShortcutsScope(MEMBER);
    window.history.replaceState({}, "", "/m/settings");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      render(inEnglish(<SettingsView data={data} lang="en" onLanguage={vi.fn()} />));
      fireEvent.click(screen.getByRole("switch", { name: "Use keyboard shortcuts" }));
      expect(keyboardShortcutsEnabled()).toBe(true);
      expect(screen.getByText("This browser could not save the choice. It applies until you reload or close this page.")).toHaveAttribute("role", "status");
    } finally {
      setItem.mockRestore();
    }
  });

  it("is not offered without a member to hold the choice", () => {
    window.history.replaceState({}, "", "/m/settings");
    render(inEnglish(<SettingsView data={{ ...data, member: { initials: "TM" } }} lang="en" onLanguage={vi.fn()} />));
    expect(screen.queryByRole("switch", { name: "Use keyboard shortcuts" })).toBeNull();
  });
});

describe("the Tasks board under the member choice", () => {
  function renderTasks() {
    window.history.replaceState({}, "", "/m/tasks");
    const props = {
      data: structuredClone(fallbackData),
      onProfile: vi.fn(), onAssistant: vi.fn(),
      onCreateTask: vi.fn(async (fields) => ({ ...fields, id: "new-task" })),
      onUpdateTask: vi.fn(async (_id, fields) => fields),
      onDeleteTask: vi.fn(async () => ({ deleted: true })),
      onSendTaskMessage: vi.fn(async () => null),
    };
    render(inEnglish(<TasksView {...props} />));
  }
  const boardKey = `sg:member:${fallbackData.member.id}:task-character-shortcuts`;

  it("keeps the board's own opt-in subordinate: no board key fires while the member choice is off", () => {
    window.localStorage.setItem(boardKey, "true");
    setKeyboardShortcutsScope(fallbackData.member.id);
    renderTasks();
    for (const key of ["/", "?", "c"]) fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: "C", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByPlaceholderText("Search tasks")).not.toHaveFocus();
    expect(screen.queryByPlaceholderText("Task title…")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    const boardSwitch = screen.getByRole("switch", { name: "Single-character shortcuts (/, c, ?)" });
    expect(boardSwitch).toBeDisabled();
    expect(boardSwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(OFF_HINT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));

    act(() => { setKeyboardShortcutsEnabled(true); });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByPlaceholderText("Search tasks")).toHaveFocus();
  });

  it("marks the help sheet off, names where to turn shortcuts on, and still closes it on Escape", async () => {
    setKeyboardShortcutsScope(fallbackData.member.id);
    renderTasks();
    fireEvent.click(screen.getByRole("button", { name: "Board view settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText(OFF_HINT)).toBeInTheDocument();
    expect(within(sheet).queryByText("Focus workstream 1–9")).toBeNull();
    expect(within(sheet).getByText("Open task")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
  });
});
