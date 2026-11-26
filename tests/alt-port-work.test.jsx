import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import AltWorkHero from "../src/alt/AltWorkHero.jsx";
import { altShellCatalogue } from "../src/lib/i18n/altShell.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { primeDemoHat } from "./helpers/demoHat.js";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// REQ-UG-ALT-PORT-WORK-20261030: the alternate shell's Work, the
// prototype's hero over the production Tasks tool's eight views. The
// prototype's Work-only dark mode is gone: the site renders light only
// (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105).

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

describe("AltWorkHero", () => {
  it("draws the crumbs and title with no dark switch, in both languages", () => {
    const onOpenHome = vi.fn();
    const { rerender } = render(<LanguageProvider lang="en"><AltWorkHero onOpenHome={onOpenHome} /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1, name: "Work" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Now" }));
    expect(onOpenHome).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /dark mode/i })).toBeNull();
    rerender(<LanguageProvider lang="es"><AltWorkHero /></LanguageProvider>);
    expect(screen.queryByRole("button", { name: /modo oscuro/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Ahora" })).toBeNull();
  });
});

describe("Work under the alternate shell (demo fixtures)", () => {
  it("frames the Tasks tool in the prototype's hero and stays light with no dark switch", async () => {
    primeDemoHat("steward");
    // view=tasks: Work opens on the case board (#6534); this suite covers Tasks.
    window.history.replaceState({}, "", "/m/tasks?demo=1&shell=alt&view=tasks");
    render(<App />);
    // Under the alternate shell the Tasks header (.phead) is display:none
    // (work.css), so the hero's h1 is the page's only visible first-level
    // heading; jsdom applies no CSS, so the query is scoped to the hero.
    await waitFor(() => expect(document.querySelector(".ug-work-hero")).not.toBeNull(), { timeout: runnerTimeout(20_000) });
    expect(within(document.querySelector(".ug-work-hero")).getByRole("heading", { level: 1, name: "Work" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".ug-work-page .kan-views")).not.toBeNull());
    expect(document.querySelector(".ug-work-page .tasks-screen > .phead h1")?.textContent).toBe("Work");
    expect(document.querySelector(".sg-app")).not.toHaveClass("ug-work-dark");
    expect(document.querySelector(".ug-work-dark")).toBeNull();
    expect(screen.queryByRole("button", { name: /dark mode/i })).toBeNull();
  }, 30_000);
});

describe("Work stylesheet and strings", () => {
  const css = readFileSync("src/alt/styles/work.css", "utf8");
  it("carries no rule for the Work-only dark mode, which nothing can turn on", () => {
    // This edition leaves out the alternate case desk and its stylesheet.
    for (const sheet of ["work.css", "design.css"]) {
      expect(readFileSync(`src/alt/styles/${sheet}`, "utf8"), sheet).not.toContain("ug-work-dark");
    }
    expect(css).toContain(".ugalt .ug-work-page .tasks-screen > .phead { display: none; }");
    expect(readFileSync("src/alt/AltShell.jsx", "utf8")).toContain('import "./styles/work.css";');
  });
  it("adds every Work string in English and Spanish", () => {
    for (const key of ["altShell.workLede"]) {
      expect(altShellCatalogue.en[key], key).toBeTruthy();
      expect(altShellCatalogue.es[key], key).toBeTruthy();
    }
    for (const key of ["altShell.workDark", "altShell.workLight", "altShell.workDarkToggle"]) {
      expect(altShellCatalogue.en[key], key).toBeUndefined();
      expect(altShellCatalogue.es[key], key).toBeUndefined();
    }
  });
});
