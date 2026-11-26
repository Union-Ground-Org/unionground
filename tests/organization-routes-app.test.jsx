// Union Ground's public union catalog (Phase 3a) routed /orgs/<slug> to a
// public organization landing page and /unions/claim/confirm to a claim
// confirmation. Union Ground leaves the public chapter directory and the
// public union catalog out (owner decision), so App sends every one of those
// addresses to the not-found page, never into the worker shell, and never
// asks a server about them.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/AppRouter.jsx";

beforeEach(() => {
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  window.history.replaceState({}, "", "/m");
});

describe("retired public organization routes in App", () => {
  it.each([
    "/orgs/example-workers-local-1",
    "/orgs/example-workers-local-1/",
    "/orgs/Not_A_Slug",
    "/unions/claim/confirm/",
  ])("renders the not-found page for %s", async (path) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Organization" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Verification" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Confirm your email" })).toBeNull();
    expect(document.querySelector(".card-nav")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
