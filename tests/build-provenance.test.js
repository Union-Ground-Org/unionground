import { describe, expect, it } from "vitest";
import { assertExactBuildSha } from "../scripts/lib/build-provenance.mjs";

describe("build provenance", () => {
  it("accepts a nonzero exact lowercase commit SHA", () => {
    const sha = "6bc9744016ac28feb349c3e7aa9de1b3db19d053";
    expect(assertExactBuildSha(sha)).toBe(sha);
  });

  it.each([
    undefined,
    "unknown",
    "6bc9744",
    "6BC9744016AC28FEB349C3E7AA9DE1B3DB19D053",
    "0".repeat(40),
  ])("rejects an untrusted build marker: %s", (value) => {
    expect(() => assertExactBuildSha(value)).toThrow(/nonzero exact lowercase commit SHA/);
  });
});
