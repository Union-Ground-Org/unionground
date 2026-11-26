import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import AltUpdatesPage, { UPDATES_PAGE, filterUpdates } from "../src/alt/AltUpdatesPage.jsx";
import { memberPageTitle } from "../src/alt/nav.js";
import { altShellCatalogue } from "../src/lib/i18n/altShell.js";
import { appViewForPath } from "../src/lib/appRoutes.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030: the prototype's All updates
// page (pages/updates.js) on the member's own record.

const NOW = new Date("2026-10-30T16:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000);
const record = (type, id, days, extra = {}) => ({ type, id, title: `${type} ${id}`, sub: `${type} sub`, at: ago(days), source: {}, ...extra });

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  window.matchMedia = vi.fn((query) => ({ matches: !query.includes("prefers-color-scheme: dark") && !query.includes("reduced-motion"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("filterUpdates", () => {
  const items = [
    record("update", "a", 2, { source: { body: "Overtime rules changed" } }),
    record("event", "b", -5, { source: { summary: "Hall B" } }),
    record("vote", "c", 60, { source: { action: "Ratify the contract" } }),
    record("case", "d", 200, { sub: "Step 1 meeting held", source: { reference: "GR-7" } }),
  ];
  it("keeps the range back from today with no upper bound, as the prototype does", () => {
    expect(filterUpdates(items, { range: "30" }, NOW).map((item) => item.id)).toEqual(["a", "b"]);
    expect(filterUpdates(items, { range: "90" }, NOW).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(filterUpdates(items, { range: "all" }, NOW)).toHaveLength(4);
    expect(filterUpdates(items, {}, NOW)).toHaveLength(3);
  });
  it("narrows by type and by every search word across title, who and body", () => {
    expect(filterUpdates(items, { range: "all", type: "vote" }, NOW).map((item) => item.id)).toEqual(["c"]);
    expect(filterUpdates(items, { range: "all", q: "overtime RULES" }, NOW).map((item) => item.id)).toEqual(["a"]);
    expect(filterUpdates(items, { range: "all", q: "hall" }, NOW).map((item) => item.id)).toEqual(["b"]);
    expect(filterUpdates(items, { range: "all", q: "ratify" }, NOW).map((item) => item.id)).toEqual(["c"]);
    expect(filterUpdates(items, { range: "all", q: "gr-7 step" }, NOW).map((item) => item.id)).toEqual(["d"]);
    expect(filterUpdates(items, { range: "all", q: "overtime hall" }, NOW)).toEqual([]);
  });
});

describe("AltUpdatesPage", () => {
  it("searches, says when nothing matches and pages the grid with Show more", () => {
    const items = Array.from({ length: UPDATES_PAGE + 3 }, (_, index) => record("update", `u${index}`, index % 20));
    render(<LanguageProvider lang="es"><AltUpdatesPage items={items} now={NOW} /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cada novedad, en el registro");
    expect(screen.getByText("Ahora")).toBeInTheDocument();
    expect(document.querySelectorAll(".ug-alt-updates .ug-ev")).toHaveLength(UPDATES_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar más" }));
    expect(document.querySelectorAll(".ug-alt-updates .ug-ev")).toHaveLength(UPDATES_PAGE + 3);
    expect(screen.queryByRole("button", { name: "Mostrar más" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar novedades" }), { target: { value: "nothing like this" } });
    expect(screen.getByText(altShellCatalogue.es["altShell.updatesNone"])).toBeInTheDocument();
    expect(document.querySelector(".ug-alt-updates-count")).toHaveTextContent("");
  });
  it("renders with no records and no handlers", () => {
    render(<LanguageProvider lang="en"><AltUpdatesPage /></LanguageProvider>);
    expect(screen.getByText(altShellCatalogue.en["altShell.updatesNone"])).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    expect(screen.getByRole("button", { name: "12 months" })).toHaveAttribute("aria-pressed", "true");
  });
  it("carries every string in English and Spanish", () => {
    const keys = Object.keys(altShellCatalogue.en).filter((key) => key.startsWith("altShell.updates") || key === "altShell.pageLede_updates" || key === "altShell.showMore");
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) expect(altShellCatalogue.es[key], key).toBeTruthy();
  });
});

describe("the All updates address", () => {
  it("is a member route and a member page title under the alternate shell", () => {
    expect(appViewForPath("/m/updates")).toBe("updates");
    expect(memberPageTitle((key, vars) => t("en", key, vars), "updates")).toBe("All updates");
  });
  it("mounts the page under the alternate shell on the member's record", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/updates?demo=1&shell=alt");
    render(<App />);
    const heading = await screen.findByRole("heading", { level: 1, name: "Every update, on the record" }, { timeout: runnerTimeout(20_000) });
    expect(heading.closest(".ug-alt-page")).not.toBeNull();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  }, 30_000);
});
