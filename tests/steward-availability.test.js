import { describe, expect, it } from "vitest";
import { appointmentWindowsError } from "../src/lib/stewardAvailability.js";

describe("weekly hours match the existing server validation", () => {
  const window = { weekday: 1, startMinute: 390, endMinute: 420 };
  it("allows the reported early and lunch hours, adjacent windows and different weekdays", () => {
    expect(appointmentWindowsError([window, { ...window, startMinute: 420, endMinute: 450 },
      { ...window, startMinute: 690, endMinute: 720 }, { ...window, weekday: 3 }])).toBeNull();
    expect(appointmentWindowsError([])).toBeNull();
  });
  it.each([
    { ...window, startMinute: null }, { ...window, endMinute: NaN },
    { ...window, endMinute: 405 }, { ...window, weekday: 7 },
    { ...window, endMinute: 1441 }, { ...window, startMinute: -1 },
  ])("rejects invalid time ranges before any write: %j", (invalid) => {
    expect(appointmentWindowsError([invalid])).toBe("appt.windowsInvalid");
  });
  it("rejects duplicates and containment as overlaps", () => {
    expect(appointmentWindowsError([window, window])).toBe("appt.windowsOverlap");
    expect(appointmentWindowsError([window, { ...window, startMinute: 380, endMinute: 450 }])).toBe("appt.windowsOverlap");
  });
  it("retains the server cap", () => {
    expect(appointmentWindowsError(Array(29).fill(window))).toBe("appt.windowsInvalid");
  });
});
