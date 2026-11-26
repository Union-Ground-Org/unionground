// (2026-10-01) restored the channel controls this file used to
// prove were retired. tests/messaging-channel-controls-contract.test.js is now
// the standing guard; this file only pins that hand-off so the old guard
// cannot silently come back. The hand-off is pinned against the contract
// test itself.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("retired channel-controls guard (superseded by D3)", () => {
  it("hands off to the restored-controls contract test", () => {
    expect(existsSync("tests/messaging-channel-controls-contract.test.js")).toBe(true);
    const contract = readFileSync("tests/messaging-channel-controls-contract.test.js", "utf8");
    expect(contract).toContain("REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001");
    expect(contract).toContain("This file replaces tests/messaging-retired-channel-controls.test.js");
    expect(contract).toMatch(/describe\(/);
  });
});
