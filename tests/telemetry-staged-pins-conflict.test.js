// @vitest-environment node
// Two pending declarations may stage the same telemetry pin only with the
// same value (OPS-UG-TELEMETRY-SDK-AND-CONFIG-PINS-STAGE-IN-PENDING-
// DECLARATIONS-20261111, review ledger item 60).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStagedTelemetryPins } from "../scripts/lib/telemetry-disclosure-sources.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function pendingRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "staged-telemetry-pins-"));
  roots.push(root);
  mkdirSync(join(root, "content/legal/pending"), { recursive: true });
  for (const [recordId, telemetryPins] of Object.entries(files)) {
    writeFileSync(join(root, "content/legal/pending", `${recordId}.json`),
      JSON.stringify({ schema: 1, recordId, release: "next", instruments: {}, telemetryPins }));
  }
  return root;
}

describe("staged telemetry pins across declarations", () => {
  it("refuses two declarations that stage different values for one pin", () => {
    const root = pendingRoot({
      "A-ONE": { "sdk/@sentry/node": "11.12.0" },
      "B-TWO": { "sdk/@sentry/node": "11.13.0" },
    });
    expect(() => readStagedTelemetryPins(root)).toThrow(/conflicting staged telemetry pin sdk\/@sentry\/node/);
  });

  it("accepts the same value staged twice and keeps each distinct pin once", () => {
    const root = pendingRoot({
      "A-ONE": { "sdk/@sentry/node": "11.12.0", "sdk/@sentry/react": "11.12.0" },
      "B-TWO": { "sdk/@sentry/node": "11.12.0" },
    });
    expect(readStagedTelemetryPins(root)).toEqual([["sdk/@sentry/node", "11.12.0"], ["sdk/@sentry/react", "11.12.0"]]);
  });

  it("reads no pins when there is no pending directory", () => {
    const root = mkdtempSync(join(tmpdir(), "staged-telemetry-pins-"));
    roots.push(root);
    expect(readStagedTelemetryPins(root)).toEqual([]);
  });
});
