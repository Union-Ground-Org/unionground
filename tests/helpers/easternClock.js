// The instants where a day counted in the wrong zone goes wrong, for web,
// native and live database tests (src/lib/easternTime.js;
// SYS-UG-SHARED-EASTERN-TIME-GUARD-20261113). The hosted databases
// and most servers run in UTC, so from 7 PM Eastern (8 PM in daylight time)
// the UTC day is already tomorrow.
export const EASTERN_INSTANTS = Object.freeze({
  // 7:30 PM EST on Thu Nov 12, 2026: the UTC day is Nov 13.
  evening: Object.freeze({ at: "2026-11-13T00:30:00.000Z", easternDay: "2026-11-12", utcDay: "2026-11-13", zone: "EST" }),
  // 8:30 PM EDT on Tue Jul 14, 2026: the UTC day is Jul 15.
  daylightEvening: Object.freeze({ at: "2026-07-15T00:30:00.000Z", easternDay: "2026-07-14", utcDay: "2026-07-15", zone: "EDT" }),
  // 11:59 PM EST on Thu Nov 12, 2026, one minute before the Eastern day ends.
  lastMinute: Object.freeze({ at: "2026-11-13T04:59:00.000Z", easternDay: "2026-11-12", utcDay: "2026-11-13", zone: "EST" }),
  // Sun Mar 14, 2027: 1:59 AM EST, then 3:00 AM EDT. The day lasts 23 hours.
  springForward: Object.freeze({ before: "2027-03-14T06:59:00.000Z", after: "2027-03-14T07:00:00.000Z", day: "2027-03-14", hours: 23 }),
  // Sun Nov 1, 2026: 1:59 AM EDT, then 1:00 AM EST again. The day lasts 25 hours.
  fallBack: Object.freeze({ before: "2026-11-01T05:59:00.000Z", after: "2026-11-01T06:00:00.000Z", day: "2026-11-01", hours: 25 }),
});

// [instant, Eastern day] pairs for a live database test of an Eastern-day
// function: select private.eastern_day($1::timestamptz) must answer the day.
export const EASTERN_DAY_CASES = Object.freeze([
  [EASTERN_INSTANTS.evening.at, EASTERN_INSTANTS.evening.easternDay],
  [EASTERN_INSTANTS.daylightEvening.at, EASTERN_INSTANTS.daylightEvening.easternDay],
  [EASTERN_INSTANTS.lastMinute.at, EASTERN_INSTANTS.lastMinute.easternDay],
  [EASTERN_INSTANTS.springForward.after, EASTERN_INSTANTS.springForward.day],
  [EASTERN_INSTANTS.fallBack.after, EASTERN_INSTANTS.fallBack.day],
]);

// Runs with the clock pinned to an instant. Pass the test file's own vi, so
// the root and native suites each use their own Vitest.
export async function atEasternInstant(vi, at, run) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

// Runs as a device or session in another zone: Node reads TZ again whenever
// it is assigned, so local-time methods follow it until it is restored.
export async function inDeviceZone(zone, run) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}
