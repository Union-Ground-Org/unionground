// @vitest-environment node
import { describe, expect, it } from "vitest";
import { staffToolAllowsHat } from "../src/lib/staffPlanes.js";

describe("integration route hat gate", () => {
  it("admits only administrator and president hats to /m/integrations", () => {
    expect(staffToolAllowsHat("integrations", "admin")).toBe(true);
    expect(staffToolAllowsHat("integrations", "vp")).toBe(true);
    for (const hat of ["member", "steward", "coordinator", "advisor"]) {
      expect(staffToolAllowsHat("integrations", hat)).toBe(false);
    }
  });
});
