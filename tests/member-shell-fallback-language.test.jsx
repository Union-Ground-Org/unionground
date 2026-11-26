import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../src/App.jsx");
  vi.restoreAllMocks();
  window.localStorage.removeItem("sg-lang");
});

it("keeps the boot language when the lazy member shell fails before it supplies its own provider", async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.doMock("../src/App.jsx", () => ({ MemberApp: () => { throw new Error("isolated member render failure"); } }));
  const { loadLanguage, t } = await import("../src/lib/i18n.js");
  await loadLanguage("es");
  window.localStorage.setItem("sg-lang", "es");
  window.history.replaceState(null, "", "/m");
  const { App } = await import("../src/AppRouter.jsx");
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(t("es", "app.crashTitle"));
  expect(screen.getByRole("button", { name: t("es", "app.crashReload") })).toBeInTheDocument();
});

it("keeps the headed top-level crash screen and a working reload when the whole member shell crashes", async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.doMock("../src/App.jsx", () => ({ MemberApp: () => { throw new Error("member shell crashed"); } }));
  window.localStorage.setItem("sg-lang", "en");
  window.history.replaceState(null, "", "/m");
  const previous = window.location;
  const reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...previous, reload } });
  try {
    const { App } = await import("../src/AppRouter.jsx");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "This screen stopped working" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing you already saved was lost. Reload to get back to your workspace; if it keeps happening, tell a committee member or organizer what you were doing.");
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: previous });
  }
});
