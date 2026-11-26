// Match the existing set_appointment_windows contract before saving settings.
// The RPC remains authoritative for role, lifecycle and tenant authorization.
export function appointmentWindowsError(windows) {
  if (!Array.isArray(windows) || windows.length > 28) return "appt.windowsInvalid";
  for (const window of windows) {
    if (!window || ![window.weekday, window.startMinute, window.endMinute].every(Number.isInteger)
      || window.weekday < 0 || window.weekday > 6
      || window.startMinute < 0 || window.startMinute > 1425
      || window.endMinute < 15 || window.endMinute > 1440
      || window.endMinute - window.startMinute < 20) return "appt.windowsInvalid";
  }
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i];
      const b = windows[j];
      if (a.weekday === b.weekday && a.startMinute < b.endMinute && b.startMinute < a.endMinute) {
        return "appt.windowsOverlap";
      }
    }
  }
  return null;
}
