import { describe, expect, it } from "vitest";
import { explicitHatAllowsView } from "../src/App.jsx";

// REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: staff reach Pulse
// from the analytics desk without switching to Member; the server authorizes
// the selected hat on every card. An unheld hat routes like Member, as it does
// for every member view, and pulse_chart_context refuses that hat server-side.
describe("website Pulse hat access", () => {
  it("opens /m/pulse under every held hat, and an unheld hat routes like Member", () => {
    expect(explicitHatAllowsView("member", "pulse", false, [])).toBe(true);
    for (const hat of ["steward", "coordinator", "advisor", "admin", "vp", "president", "treasurer", "secretary"]) {
      expect(explicitHatAllowsView(hat, "pulse", false, [hat]), hat).toBe(true);
    }
    expect(explicitHatAllowsView("admin", "pulse", false, [])).toBe(explicitHatAllowsView("admin", "numbers", false, []));
    // Before this record a staff hat could not open Pulse at all.
    expect(explicitHatAllowsView("steward", "numbers", false, ["steward"])).toBe(false);
  });
});
