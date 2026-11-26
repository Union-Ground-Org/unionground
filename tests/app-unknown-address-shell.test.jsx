import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/AppRouter.jsx";
import { APP_SHELL_FALLBACK_PATH, unknownAppPath } from "../src/lib/appRoutes.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// UB-UG-UNKNOWN-APP-ADDRESS-LEAVES-SHELL-20261106: a mistyped or stale
// address under /m used to drop a signed-in viewer onto the public 404 page,
// losing the rail, the hat and their place. It now keeps the shell, shows the
// shell's own not-found page and offers the way back to the current hat's
// home; an unknown public address keeps the public 404.

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/m");
});

async function shellNotFound() {
  const heading = await screen.findByRole("heading", { level: 1, name: "Page not found" }, { timeout: runnerTimeout(10_000) });
  const card = heading.closest("[data-app-not-found]");
  expect(card, "the not-found page renders inside the app shell").not.toBeNull();
  expect(card.closest("main"), "inside the shell's main region").not.toBeNull();
  // The public 404 document (its "On this page" index) is not on screen.
  expect(screen.queryByRole("heading", { level: 2, name: "Where to go next" })).not.toBeInTheDocument();
  return card;
}

describe.each(["classic", "alt"])("an unknown in-app address in the %s shell", (shell) => {
  it("keeps the shell and goes back to Home under the Member hat", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", `/m/not-a-route?demo=1&shell=${shell}`);
    render(<App />);
    const card = await shellNotFound();
    expect(window.location.pathname).toBe("/m/not-a-route");
    fireEvent.click(within(card).getByRole("button", { name: "Back to Home" }));
    expect(window.location.pathname).toBe("/m");
    expect(new URLSearchParams(window.location.search).get("demo")).toBe("1");
    expect(document.querySelector("[data-app-not-found]")).toBeNull();
  }, 30_000);

  it("goes back to the worn staff desk, not Member Home", async () => {
    primeDemoHat("steward");
    window.history.replaceState({}, "", `/m/steward/not-a-page?demo=1&shell=${shell}`);
    render(<App />);
    await shellNotFound();
    // The hat route gate does not treat the unknown address as a refused
    // route and bounce the worn desk to its home: the page stays put.
    await waitFor(() => expect(document.querySelector("[data-app-not-found] button")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(window.location.pathname).toBe("/m/steward/not-a-page");
    const card = document.querySelector("[data-app-not-found]");
    expect(card).not.toBeNull();
    const back = within(card).getByRole("button", { name: /^Back to / });
    expect(back).not.toHaveAccessibleName("Back to Home");
    fireEvent.click(back);
    expect(window.location.pathname).toBe("/m/steward");
    expect(document.querySelector("[data-app-not-found]")).toBeNull();
  }, 30_000);
});

describe("an unknown public address", () => {
  it("keeps the public 404 page", async () => {
    window.history.replaceState({}, "", "/not-a-page");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" }, { timeout: runnerTimeout(8_000) })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Where to go next" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
    expect(document.querySelector("[data-app-not-found]")).toBeNull();
  });
});

describe("the shell fallback route", () => {
  it("claims only unknown addresses under /m", () => {
    expect(unknownAppPath("/m/not-a-route/")).toBe(true);
    expect(unknownAppPath("/m/settings/invented")).toBe(true);
    expect(unknownAppPath("/m/messages")).toBe(false);
    expect(unknownAppPath("/m/steward/caseload")).toBe(false);
    expect(unknownAppPath("/m")).toBe(false);
    expect(unknownAppPath("/not-a-page")).toBe(false);
    expect(unknownAppPath("/mx/not-a-page")).toBe(false);
    expect(unknownAppPath("")).toBe(false);
  });

  it("is the last Vercel rewrite, after every exact shell route", () => {
    const { rewrites } = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(rewrites.at(-1)).toEqual({ source: APP_SHELL_FALLBACK_PATH, destination: "/index.html" });
    // Besides the shell, only this edition's two retired legacy trees reach the
    // app, where RetiredLegacyView explains the retirement (src/AppRouter.jsx).
    expect(rewrites.filter((entry) => entry.source.includes(":path*") && entry.destination === "/index.html"))
      .toEqual([
        { source: "/contractsurvey/:path*", destination: "/index.html" },
        { source: "/design/:path*", destination: "/index.html" },
        { source: "/m/:path*", destination: "/index.html" },
      ]);
  });
});
