import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// BUG-UG-PASSWORD-REISSUE-HAT-AND-DISCOVERY-20261003 (Codex P2 on
// #3935): opening the search result from the Worker hat must wear Admin AND
// land on sign-in help, not stop at the Admin desk's root.

beforeEach(() => {
  window.history.replaceState({}, "", "/m/search");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => primeDemoData(fallbackData));

describe("the password reissue search result", () => {
  it("wears the Admin desk and opens sign-in help from the Worker hat", async () => {
    primeDemoData({ ...fallbackData, roles: ["admin"] });
    render(<App />);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search" }), { target: { value: "reissue" } });
    fireEvent.click(await screen.findByRole("button", { name: /Send a worker a new password/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/admin/signin-recovery"));
    expect(await screen.findByRole("heading", { name: "Sign-in help: new password or address" })).toBeInTheDocument();
  });

  it("is offered in the command palette and opens sign-in help from there too", async () => {
    primeDemoData({ ...fallbackData, roles: ["admin"] });
    window.history.replaceState({}, "", "/m");
    render(<App />);
    await screen.findByRole("heading", { name: PHONE_HOME_GREETING });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Search commands" }), { target: { value: "reissue" } });
    fireEvent.click(await screen.findByRole("option", { name: /Send a worker a new password/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/admin/signin-recovery"));
  });
});
