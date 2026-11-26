import { afterEach, describe, expect, it, vi } from "vitest";

describe("visual-audit device-parity hook", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete window.__ugApplyDeviceParityState;
    delete window.__ugPendingDeviceParity;
  });

  it("flushes a queued hat and exposes apply when VITE_VISUAL_AUDIT is on", async () => {
    vi.stubEnv("VITE_VISUAL_AUDIT", "1");
    window.__ugPendingDeviceParity = [["app.selectedStaffHat", "member"]];
    vi.resetModules();
    const { applyDeviceParityState, deviceParityValue } = await import("../src/lib/deviceParity.js");
    expect(deviceParityValue("app.selectedStaffHat")).toBe("member");
    expect(window.__ugApplyDeviceParityState).toBe(applyDeviceParityState);
    expect(window.__ugPendingDeviceParity).toEqual([]);
  });

  it("ignores a non-array pending queue", async () => {
    vi.stubEnv("VITE_VISUAL_AUDIT", "1");
    window.__ugPendingDeviceParity = { hat: "member" };
    vi.resetModules();
    const { deviceParityValue } = await import("../src/lib/deviceParity.js");
    expect(deviceParityValue("app.selectedStaffHat")).toBeUndefined();
    expect(window.__ugPendingDeviceParity).toEqual({ hat: "member" });
  });

  it("skips invalid queued entries and still applies valid pairs", async () => {
    vi.stubEnv("VITE_VISUAL_AUDIT", "1");
    window.__ugPendingDeviceParity = [
      null,
      "member",
      ["app.selectedStaffHat"],
      ["app.selectedStaffHat", "member", "extra"],
      { key: "app.selectedStaffHat", value: "steward" },
      ["app.selectedStaffHat", "member"],
    ];
    vi.resetModules();
    const { deviceParityValue } = await import("../src/lib/deviceParity.js");
    expect(deviceParityValue("app.selectedStaffHat")).toBe("member");
    expect(window.__ugPendingDeviceParity).toEqual([]);
  });

  it("leaves the apply hook absent and the pending queue unchanged when both preview flags are unset", async () => {
    vi.stubEnv("VITE_E2E_HARNESS", "");
    vi.stubEnv("VITE_VISUAL_AUDIT", "");
    delete window.__ugApplyDeviceParityState;
    const queued = [["app.selectedStaffHat", "member"]];
    window.__ugPendingDeviceParity = queued;
    vi.resetModules();
    const { deviceParityValue } = await import("../src/lib/deviceParity.js");
    expect(window.__ugApplyDeviceParityState).toBeUndefined();
    expect(window.__ugPendingDeviceParity).toBe(queued);
    expect(window.__ugPendingDeviceParity).toEqual([["app.selectedStaffHat", "member"]]);
    expect(deviceParityValue("app.selectedStaffHat")).toBeUndefined();
  });
});
