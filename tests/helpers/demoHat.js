import { applyDeviceParityState } from "../../src/lib/deviceParity.js";

// Fixture suites that still exercise Member screens on ?demo=1 must pin the
// hat before render. The ?demo=1 harness entry defaults to Steward; without this
// prime those suites bounce to the steward desk.
export function primeDemoHat(hat = "member") {
  applyDeviceParityState("app.selectedStaffHat", hat);
}
