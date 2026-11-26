// BUG-UG-SETTINGS-SHOWS-RAW-KEY-TASKS-THEME-20261006: the Settings menu
// named its appearance page with `tasks.theme`, a key the theme retirement
// (#3844) removed, so members read the raw key. Every workspace page label must
// resolve in the catalogue in both languages.
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { SETTINGS_PAGES, WORKSPACE_PAGES } from "../src/lib/workspacePages.js";

const labelled = [...SETTINGS_PAGES, ...WORKSPACE_PAGES].filter((page) => page.labelKey);

describe("workspace page labels", () => {
  it("covers the Settings menu and the staff role pages", () => {
    expect(SETTINGS_PAGES.length).toBeGreaterThan(0);
    expect(labelled.length).toBeGreaterThan(SETTINGS_PAGES.length);
  });

  it.each(["en", "es"])("names every page with a catalogue entry in %s", (lang) => {
    const missing = labelled
      .filter((page) => typeof catalogue[lang][page.labelKey] !== "string" || !catalogue[lang][page.labelKey].trim())
      .map((page) => `${page.key}: ${page.labelKey}`);
    expect(missing).toEqual([]);
  });

  it("labels the appearance page with the most-used-places card it holds", () => {
    const appearance = SETTINGS_PAGES.find((page) => page.key === "settings-appearance");
    expect(appearance.labelKey).toBe("navUsage.settingsTitle");
    expect(catalogue.en[appearance.labelKey]).toBe("Most used places");
    expect(catalogue.es[appearance.labelKey]).toBe("Lugares más usados");
  });
});
