import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { primeDemoData } from "../src/data/demoData.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// UX-UG-STAFF-LINKS-FROM-WRONG-DESK-LAND-ON-HOME-OR-OVERVIEW-20261111,
// G7 P1 on #8285: on the desktop rail, clicking the desk the refusal named
// opened that desk's overview and dropped the query, while the phone Desks
// button opened the refused address. Only the desktop breakpoint matches here.
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes("min-width: 1024px"),
    media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
  }));
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  primeDemoData(fallbackData);
});

const primaryRail = async () => within(await screen.findByRole("navigation", { name: "Primary" }));

describe("the desktop rail after a refused address", () => {
  it("opens the refused address, query included, when the person clicks the desk the notice named", async () => {
    primeDemoData({ ...fallbackData, roles: ["vp"] });
    window.history.replaceState({}, "", "/m/tasks?view=list");
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    fireEvent.click((await primaryRail()).getByRole("link", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/tasks"));
    expect(window.location.search).toBe("?view=list");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
  });

  it("opens the desk overview once the remembered address has been used", async () => {
    primeDemoData({ ...fallbackData, roles: ["vp"] });
    window.history.replaceState({}, "", "/m/tasks");
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe("/m"));
    fireEvent.click((await primaryRail()).getByRole("link", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/tasks"));
    act(() => {
      window.history.pushState({}, "", "/m");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    fireEvent.click((await primaryRail()).getByRole("link", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/vp"));
  });
});
