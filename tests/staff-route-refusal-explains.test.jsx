import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

// BUG-UG-M-ROUTES-REDIRECT-TO-HOME-20261003: in the October 3 pilot a
// President, an Admin and a member typed /m/organization-map, /m/tasks,
// /m/campaigns and /m/analytics and landed on Home with only "Your Member hat
// cannot open that page." Staff pages still fail closed under the Member hat
// but the notice now names the page and what
// opens it.

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => primeDemoData(fallbackData));

async function openDirect(path, roles) {
  primeDemoData({ ...fallbackData, roles });
  window.history.replaceState({}, "", path);
  render(<App />);
  expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe("/m"));
  return [...document.querySelectorAll("[data-staff-route-refusal] p")].map((node) => node.textContent);
}

describe("a staff page opened under the Member hat", () => {
  it("brings a new history refusal into view and focuses its explanation", async () => {
    await openDirect("/m/campaigns", ["admin"]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    window.scrollTo.mockClear();
    act(() => {
      window.history.pushState({}, "", "/m/campaigns");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const explanation = screen.getByText("Campaigns opens from your Admin desk. Switch to Admin and it opens there.");
    expect(explanation.closest('[role="status"]')).toHaveFocus();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    expect(window.location.pathname).toBe("/m");
  });

  it("keeps the explanation after the toast interval and lets the visitor dismiss it", async () => {
    await openDirect("/m/campaigns?hat=admin", ["admin"]);
    vi.useFakeTimers();
    try {
      await act(() => vi.advanceTimersByTimeAsync(7000));
      const notice = screen.getByText("Campaigns opens from your Admin desk. Switch to Admin and it opens there.");
      expect(notice).toBeInTheDocument();
      expect(window.location.pathname).toBe("/m");
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(notice).not.toBeInTheDocument();
      expect(document.getElementById("main-content")).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the explanation after leaving the fallback page", async () => {
    await openDirect("/m/campaigns", ["admin"]);
    const notice = screen.getByText("Campaigns opens from your Admin desk. Switch to Admin and it opens there.");
    act(() => {
      window.history.pushState({}, "", "/m/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(notice).not.toBeInTheDocument());
  });

  it.each([
    ["/m/tasks", "Tasks"],
    ["/m/organization-map", "Organization map"],
    ["/m/campaigns", "Campaigns"],
    ["/m/analytics", "Organization analytics"],
  ])("%s names the Campaign chair desk that opens it", async (path, page) => {
    expect(await openDirect(path, ["vp"])).toEqual([`${page} opens from your Campaign chair desk. Switch to Campaign chair and it opens there.`]);
  });

  it("tells a member without a staff role that the page is for chapter staff", async () => {
    expect(await openDirect("/m/analytics", [])).toEqual(["Organization analytics is only for campaign staff, so Home opened instead."]);
  });

  it("names the role another desk needs", async () => {
    expect(await openDirect("/m/admin", ["vp"])).toEqual(["The Admin desk needs the Admin role, so Home opened instead."]);
  });

  // Codex P2 on: staff-only tabs inside member workspaces are refused
  // by path, not by view, and get the same explanation.
  it("names the desk for a staff-only workspace tab", async () => {
    expect(await openDirect("/m/support/handoffs", ["steward"])).toEqual(["That page opens from your Committee desk. Switch to Committee and it opens there."]);
  });

  it("tells a member without a staff role that a staff-only tab is for chapter staff", async () => {
    expect(await openDirect("/m/coordination/operations", [])).toEqual(["That page is only for campaign staff, so Home opened instead."]);
  });
});
