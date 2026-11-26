// @vitest-environment node

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "vite";
import configure from "../vite.config.mjs";

// The recipe catalogue freezes itself through a helper whose Object.freeze
// call is a bare statement. Source imports stay frozen whatever the bundler
// does, so only an executed production bundle shows whether the build's
// tree-shaking settings (a global Object.freeze purity entry did this under
// Vite 8, #8447) dropped that call.
const RECIPES = fileURLToPath(new URL("../src/features/automation/recipes.js", import.meta.url));
const ENTRY = "virtual:automation-recipes-production-entry";

describe("automation recipes production bundle", () => {
  it("keeps the canonical recipes frozen after the shipped tree-shaking and minifier", async () => {
    const production = configure({ mode: "production" }).build;
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [{
        name: "automation-recipes-production-entry",
        resolveId: (id) => (id === ENTRY ? id : null),
        load: (id) => (id === ENTRY ? `export { AUTOMATION_RECIPES, getAutomationRecipe } from ${JSON.stringify(RECIPES)};` : null),
      }],
      build: {
        write: false,
        target: production.target,
        rolldownOptions: {
          ...production.rolldownOptions,
          input: ENTRY,
          preserveEntrySignatures: "strict",
          output: { format: "esm", codeSplitting: false },
        },
      },
    });
    const output = Array.isArray(result) ? result.flatMap((entry) => entry.output) : result.output;
    const bundle = output.find((item) => item.type === "chunk" && item.isEntry);
    const built = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString("base64")}`);
    expect(built.AUTOMATION_RECIPES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(built.AUTOMATION_RECIPES)).toBe(true);
    expect(Object.isFrozen(built.getAutomationRecipe("casework-filing-preparation").draft.conditions)).toBe(true);
  });
});
