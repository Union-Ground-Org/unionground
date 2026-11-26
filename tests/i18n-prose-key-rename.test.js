import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { PROSE_KEY_RENAMES } from "../scripts/lib/i18n-prose-key-rename-map.mjs";
import {
  checkProseKeyRename,
  leftoverProseKeys,
} from "../scripts/i18n-rename-prose-keys.mjs";

describe("i18n prose-derived keys renamed to surface-and-role names", () => {
  it("maps 90 keys (88 sentence-shaped plus the four ordinals, two of which overlap)", () => {
    expect(PROSE_KEY_RENAMES).toHaveLength(90);
    const ordinals = PROSE_KEY_RENAMES.filter((row) => row.from.endsWith(".2"));
    expect(ordinals).toHaveLength(4);
    expect(ordinals.map((row) => row.to).sort()).toEqual([
      "automation.builder.stepWhen",
      "automation.pages.connectedVersion",
      "automation.pages.historicalSelectedChapter",
      "automation.pages.schedulerMissing",
    ]);
  });

  it("keeps EN and ES value multisets equal to the frozen mapping", () => {
    const result = checkProseKeyRename(catalogue);
    expect(result.failures, result.failures.join("\n")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.enMultisetEqual).toBe(true);
    expect(result.esMultisetEqual).toBe(true);
  });

  it("removes every old quoted key from src and tests", () => {
    expect(leftoverProseKeys()).toEqual([]);
  });

  it("documents the surface-and-role convention in the catalogue header", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/i18n.js"), "utf8");
    expect(source).toContain("KEY NAMES: a key names the surface and the role, never the sentence it");
    expect(source).toContain("Disambiguate with a role suffix, never an ordinal (.2).");
  });
});
