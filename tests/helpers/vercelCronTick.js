// The request headers Vercel documents for a scheduled cron tick, and nothing
// else: the configured CRON_SECRET as the bearer, the vercel-cron/1.0 user agent
// and x-vercel-cron-schedule. Vercel sends no x-vercel-cron marker
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs, read Nov 17, 2026;
// BUG-UG-EIGHT-SCHEDULED-ROUTES-REFUSE-REAL-VERCEL-CRON-TICKS-20261117).
// A success test for a scheduled route sends these headers, never the marker.
export function vercelCronTickHeaders(cronSecret, schedule = "*/15 * * * *") {
  return {
    authorization: `Bearer ${cronSecret}`,
    "user-agent": "vercel-cron/1.0",
    "x-vercel-cron-schedule": schedule,
  };
}

// The same tick without the bearer, carrying a spoofed marker as well: no
// header, including x-vercel-cron, may authorize a scheduled route.
export function unauthenticatedCronTickHeaders(schedule = "*/15 * * * *") {
  return {
    "user-agent": "vercel-cron/1.0",
    "x-vercel-cron-schedule": schedule,
    "x-vercel-cron": "1",
  };
}
