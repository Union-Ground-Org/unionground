import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

// tests/setup.js turns jsdom 31's timed focus fixup off for root DOM tests;
// a single test can turn it back on.

function focusedButtonThatGetsDisabled() {
  const button = document.createElement("button");
  button.textContent = "Save";
  document.body.append(button);
  button.focus();
  expect(document.activeElement).toBe(button);
  button.disabled = true;
  return button;
}

afterEach(() => { document.body.replaceChildren(); });

describe("jsdom focus fixup in root tests", () => {
  it("still finds jsdom's focus fixup hook, so a jsdom upgrade that renames it fails here", () => {
    expect(typeof window._requestFocusFixup).toBe("function");
    const jsdomRoot = dirname(createRequire(import.meta.url).resolve("jsdom/package.json"));
    expect(readFileSync(join(jsdomRoot, "lib/jsdom/browser/Window.js"), "utf8")).toContain("window._requestFocusFixup = () =>");
  });

  it("keeps focus on a focused control that becomes disabled, by default", async () => {
    const button = focusedButtonThatGetsDisabled();
    await afterRenderingUpdate();
    expect(document.activeElement).toBe(button);
  });

  it("moves focus off it at the next rendering update when a test turns the fixup on, as a browser does", async () => {
    enableFocusFixup();
    focusedButtonThatGetsDisabled();
    await afterRenderingUpdate();
    expect(document.activeElement).toBe(document.body);
  });

  it("turns the fixup off again after the test that turned it on", async () => {
    const button = focusedButtonThatGetsDisabled();
    await afterRenderingUpdate();
    expect(document.activeElement).toBe(button);
  });
});
