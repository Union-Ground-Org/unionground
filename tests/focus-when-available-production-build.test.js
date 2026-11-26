// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { build } from "vite";

const APP_SOURCE = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

function focusHelperSource() {
  const focusStart = APP_SOURCE.indexOf("export function focusWhenAvailable(");
  expect(focusStart, "focusWhenAvailable must remain available to the app and its regressions")
    .toBeGreaterThanOrEqual(0);
  const clockStart = APP_SOURCE.lastIndexOf("\nfunction focusClockNow(", focusStart);
  const start = clockStart >= 0 ? clockStart + 1 : focusStart;
  const end = APP_SOURCE.indexOf("\n}\n", focusStart);
  expect(end, "focusWhenAvailable source boundary was not found").toBeGreaterThan(focusStart);
  return APP_SOURCE.slice(start, end + 2).replace(/^export /gm, "");
}

describe("focus restoration production bundle", () => {
  it("executes the default focus deadline after the shipped browser transform", async () => {
    const entry = `${focusHelperSource()}

let focused = false;
focusWhenAvailable(() => ({
  isConnected: true,
  focus() { focused = true; },
}));
if (!focused) throw new Error("focus target was not restored");
`;
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [{
        name: "virtual-focus-deadline-entry",
        resolveId(id) {
          return id === "virtual:focus-deadline-entry" ? id : null;
        },
        load(id) {
          return id === "virtual:focus-deadline-entry" ? entry : null;
        },
      }],
      build: {
        write: false,
        target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
        rolldownOptions: {
          input: "virtual:focus-deadline-entry",
          output: { format: "iife" },
        },
      },
    });
    const output = Array.isArray(result)
      ? result.flatMap((entryResult) => entryResult.output)
      : result.output;
    const bundle = output.find((item) => item.type === "chunk" && item.isEntry);
    expect(bundle).toBeDefined();
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    expect(() => new Function(bundle.code)()).not.toThrow();
  });
});
