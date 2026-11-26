import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/AppRouter.jsx";

const probe = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock("../src/App.jsx", () => {
  probe.loaded();
  return { MemberApp: () => <h1>Member shell boundary</h1> };
});
vi.mock("../src/views/AboutView.jsx", () => ({ AboutView: () => <h1>Standalone about page</h1> }));

describe("lazy member shell routing", () => {
  beforeEach(() => { probe.loaded.mockClear(); });

  it("opens a standalone page without evaluating the member shell", async () => {
    window.history.replaceState(null, "", "/about");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Standalone about page" })).toBeInTheDocument();
    expect(probe.loaded).not.toHaveBeenCalled();
  });

  it("loads the member shell for a member address", async () => {
    window.history.replaceState(null, "", "/m/today");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Member shell boundary" })).toBeInTheDocument();
    expect(probe.loaded).toHaveBeenCalledOnce();
  });
});
