import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOverview, WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { workspaceOverviewCopy } from "../src/lib/workspaceOverviewCopy.js";

// BUG-UG-SETTINGS-MORE-SITE-MAP-WORDING-20261106: the overview help
// line read like a site map. Its copy lives in its own module so the locale
// barrels stay byte-identical (the release guard reads any barrel edit as a
// published legal change).
afterEach(cleanup);

describe("workspace overview help line", () => {
  it.each(["en", "es"])("shows the product wording in %s", (lang) => {
    window.history.replaceState({}, "", "/m/settings");
    render(<LanguageProvider lang={lang}><WorkspacePages view="settings" location="/m/settings" navigate={vi.fn()}><WorkspaceOverview /></WorkspacePages></LanguageProvider>);
    const help = document.querySelector(".workspace-directory > p");
    expect(help.textContent).toBe(workspaceOverviewCopy[lang].help);
    expect(help.textContent).not.toMatch(/address|dirección/i);
  });

  it("no longer reads the old barrel key", () => {
    expect(readFileSync(resolve(process.cwd(), "src/components/WorkspacePages.jsx"), "utf8")).not.toContain("workspace.overviewHelp");
    expect(workspaceOverviewCopy.en.help).toBe("Choose a section to see its pages.");
    expect(workspaceOverviewCopy.es.help).toBe("Elige una sección para ver las páginas que contiene.");
  });
});
