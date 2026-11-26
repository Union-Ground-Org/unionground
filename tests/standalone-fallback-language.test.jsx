// BUG-UG-STANDALONE-FALLBACK-LANGUAGE-20261025: a standalone page's
// loading screen and its load-failed screen sit under the English/Español
// switch, so switching language while either is showing changes its text, and
// the failed page keeps its reload control.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../src/lib/i18n.js";

const VIEW = "../src/views/RequestInviteView.jsx";

async function freshApp(factory) {
  vi.resetModules();
  vi.doMock(VIEW, factory);
  return (await import("../src/AppRouter.jsx")).App;
}

beforeEach(() => {
  window.localStorage.setItem("sg-lang", "en");
  window.history.replaceState({}, "", "/request-invite");
  // No document probe succeeds, so the boundary never reloads on its own.
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  vi.doUnmock(VIEW);
  window.localStorage.removeItem("sg-lang");
  window.history.replaceState({}, "", "/");
  document.documentElement.lang = "";
});

describe("standalone fallbacks follow the selected language", () => {
  it("switches the loading text while the page's chunk is still loading", async () => {
    const App = await freshApp(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByRole("status")).toHaveTextContent(t("en", "app.loading"));
    fireEvent.click(screen.getByRole("button", { name: "Español" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t("es", "app.loading")));
    expect(screen.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Español" })).toHaveAttribute("lang", "es");
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("lang", "en");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t("en", "app.loading")));
  });

  it("switches the load-failed text after lazy-load recovery is exhausted and keeps the reload control", async () => {
    let calls = 0;
    const App = await freshApp(() => { calls += 1; throw new TypeError("Failed to fetch dynamically imported module"); });
    render(<App />);
    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alert).toHaveTextContent(t("en", "app.viewLoadFailedTitle"));
    expect(calls).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Español" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(t("es", "app.viewLoadFailedTitle")));
    expect(screen.getByRole("alert")).not.toHaveTextContent(t("en", "app.viewLoadFailedTitle"));
    // The reload control stays, now labelled in Spanish; nothing retried or
    // reloaded on the switch itself.
    expect(screen.getByRole("button", { name: t("es", "app.tryAgain") })).toHaveClass("dialog-primary");
    expect(calls).toBe(2);
  });
});
