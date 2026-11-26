// One identity replaces the selectable app themes (design Step 2).
//
// Superseded rule, quoted from this file until Step 2: "App-wide themes
// (REQ-UNION-BASE-WORK-TAB-THEMES-20260822, system-wide by owner direction
// 2026-08-22). Four sync surfaces have to agree for a palette to be real: the
// registry in src/lib/workTabTheme.js (what the picker offers), the kanban block
// and the workspace block in styles.css ..., and the `work-*` / `sys-*` scopes in
// scripts/contrast-audit.mjs."
//
// New rule (October 2 design direction, decision 2;
// 2026 1:40 PM ET: "retire the five selectable palettes (one identity
// everywhere)" and "fold Night Shift into dark mode"): there is no picker and no
// registry; a palette saved under "sg-app-theme" is never read. The owner's
// order of November 5, 2026 (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105)
// made the site light only: the system setting is never read, and the
// identity's dark form, which stayed dormant, is deleted with its app block,
// board block, tokens and audit scope.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scopes } from "../scripts/contrast-audit.mjs";
import { stripComments } from "../scripts/lib/css-vars.mjs";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { TasksView } from "../src/views/TasksView.jsx";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(join(root, "src/styles.css"), "utf8");
const appSource = readFileSync(join(root, "src/App.jsx"), "utf8");
const settingsSource = readFileSync(join(root, "src/views/SettingsView.jsx"), "utf8");
const tasksSource = readFileSync(join(root, "src/views/TasksView.jsx"), "utf8");

const realMatchMedia = window.matchMedia;

function mockMatchMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: matches(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  mockMatchMedia((query) => !query.includes("prefers-reduced-motion") && !query.includes("prefers-color-scheme"));
  window.history.replaceState({}, "", "/m/tasks");
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  window.localStorage.clear();
  document.title = "Union Ground";
});

function renderTasks(props = {}) {
  return render(
    <LanguageProvider lang="en">
      <TasksView
        data={structuredClone(fallbackData)}
        desktopShell
        onProfile={vi.fn()}
        onAssistant={vi.fn()}
        {...props}
      />
    </LanguageProvider>,
  );
}

describe("retired app theme picker", () => {
  it("offers no palette choice on the board or in Settings", () => {
    const { container } = renderTasks({ onSelectWorkTheme: vi.fn() });
    fireEvent.click(within(container).getByRole("button", { name: "Board view settings" }));
    expect(within(container).queryByRole("radiogroup", { name: "App theme" })).toBeNull();
    expect(tasksSource).not.toMatch(/onSelectWorkTheme|WORK_TAB_THEMES|kan-theme/);
    expect(settingsSource).not.toMatch(/onSelectAppTheme|WORK_TAB_THEMES|setin-theme/);
    expect(styles).not.toMatch(/\.(setin|kan)-theme\b/);
  });

  it("removes the picker's catalogue keys in both languages", () => {
    for (const lang of ["en", "es"]) {
      const keys = Object.keys(catalogue[lang]).filter((key) => key === "tasks.theme" || key.startsWith("tasks.theme."));
      expect(keys, lang).toEqual([]);
    }
  });

  // REQ-UG-WEB-IDENTITY-TOKENS-DARK-MODE-STEP-TWO-20261003, acceptance 2:
  // "Each person's stored theme choice (sg-app-theme) is retained unread,
  // never deleted or migrated, until the owner rules on it."
  it("never reads a saved palette, so an old choice is ignored without an error", () => {
    expect(appSource).not.toMatch(/loadWorkTabTheme|workTabTheme\.js|getItem\(\s*["']sg-app-theme/);
    expect(appSource).not.toMatch(/appTheme=|onSelectAppTheme=|onSelectWorkTheme=/);
    window.localStorage.setItem("sg-app-theme", "night-shift");
    const { container } = renderTasks();
    expect(container.querySelector(".tasks-screen")).not.toHaveAttribute("data-work-theme");
  });

  it("retains the stored choice unread: nothing deletes, rewrites or migrates sg-app-theme", () => {
    for (const source of [appSource, settingsSource, tasksSource]) {
      expect(source).not.toMatch(/removeItem\(\s*["']sg-app-theme/);
      expect(source).not.toMatch(/setItem\(\s*["']sg-app-theme/);
    }
    window.localStorage.setItem("sg-app-theme", "collected");
    const { unmount } = renderTasks();
    unmount();
    expect(window.localStorage.getItem("sg-app-theme")).toBe("collected");
  });
});

describe("the site renders light only", () => {
  it("never reads the system colour scheme in App", () => {
    expect(appSource).not.toMatch(/prefers-color-scheme|useSystemDarkScheme|colorScheme\.js/);
    expect(appSource).not.toContain("union-ground-dark");
    expect(appSource).toMatch(/resolveRenderedWorkspaceTheme\(workspaceTheme, false\);/);
    // a review note deleted the board's own theme carrier, which could
    // only ever be null.
    expect(appSource).not.toMatch(/workBoardThemeFor|renderedWorkTabTheme|workTheme=/);
    expect(tasksSource).not.toContain("data-work-theme");
  });
});

// The dormant dark form is deleted: no rule, token or
// audit scope may name it again.
describe("the identity's dark form is deleted", () => {
  it("leaves no rule, token or carrier of the dark form in the stylesheet", () => {
    const sheet = stripComments(styles);
    expect(sheet).not.toMatch(/data-(workspace|work)-theme="(union-ground-dark|night-shift)"/);
    expect(sheet).not.toMatch(/--sg-dark-[\w-]+/);
    expect(sheet).not.toContain("data-work-theme");
  });

  it("measures the identity only, and nothing retired", () => {
    // The signed-out pages keep this edition's theme: no public overlay scope.
    expect(scopes.map(({ name }) => name).sort()).toEqual(["app", "kanban", "union-ground"]);
  });
});

describe("retired palette styles", () => {
  // Superseded rule, quoted from this file until design Step 2: "keeps every
  // visible treatment beneath the Collected attribute scope". The Collected,
  // Cobalt Signal, Aubergine Ledger and Union Printroom palettes are retired,
  // and the owner's ruling of November 3, 2026 retires the steward's Harbor
  // Ledger too, so no rule,:not() exclusion included, may name any of them.
  it("leaves no rule that targets a retired palette", () => {
    const retired = /\[data-workspace-theme="(harbor-ledger|cobalt-signal|ledger-aubergine|union-printroom|collected)"\]|\[data-work-theme="(cobalt-signal|aubergine-ledger|union-printroom|collected)"\]/;
    const offenders = stripComments(styles).split("\n").filter((line) => retired.test(line));
    expect(offenders).toEqual([]);
  });
});
