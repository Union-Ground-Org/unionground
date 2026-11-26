import { existsSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AutomationDiscover } from "../src/features/automation/AutomationDiscover.jsx";

// Dues and contract clauses are left out of Union Ground: a group still
// forming a union has neither. Their locale tests went with them; the
// automation copy helper this file also covered stays.
describe("feature copy helpers locale", () => {
  it("renders AutomationDiscover from the catalogue in Spanish", () => {
    render(
      <LanguageProvider lang="es">
        <AutomationDiscover
          connected={false}
          access={{ canAuthor: false, canApprove: false, canOperate: false }}
          capabilities={null}
          opportunities={[]}
          onStartDraft={vi.fn()}
          onOpenRecipes={vi.fn()}
        />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", {
      name: catalogue.es["automation.discover.heroTitle"],
    })).toBeVisible();
    expect(screen.getByText(catalogue.es["automation.connected.authoring.installed"])).toBeVisible();
    expect(screen.getByRole("button", { name: catalogue.es["automation.browse.recipes"] })).toBeEnabled();
    expect(screen.queryByText("Make routine follow-up dependable")).toBeNull();
    expect(screen.queryByText("Drafting automations isn't set up for this organization yet.")).toBeNull();
  });

  it("ships no dues view or contract-clause reference to localise", () => {
    for (const path of [
      "src/views/DuesView.jsx",
      "src/features/dues/contract.js",
      "src/features/clauses/ui/ClauseQuickReference.jsx",
      "src/features/clauses/index.js",
    ]) {
      expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(false);
    }
  });
});
