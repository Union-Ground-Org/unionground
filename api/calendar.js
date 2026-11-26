import { methodGuard, unionGroundProvider, requireEnv, supabaseRpc } from "./_lib/http.js";
import { buildIcsCalendar } from "../src/lib/ics.js";

// Personal ICS subscribe feed. The caller is a calendar app polling a bare
// URL — no Supabase session — so authorization is the opaque ?token= secret,
// resolved server-side by the service-role-only get_calendar_feed_events RPC.
// This function is the ONLY place the service-role key meets that RPC; the
// token itself never reaches the database in logs (only its sha256 is
// compared) and an unknown/revoked token is a plain 404.
export default async function handler(request, response) {
  // A calendar app is the caller, so every refusal stays plain text rather than
  // the JSON the browser-facing routes answer with.
  if (methodGuard(request, ["GET"], () => {
    response.status(405).setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Method not allowed.");
  })) return;

  const { ok: providerValid, supabaseUrl, serviceRoleKey } = unionGroundProvider();
  if (requireEnv([providerValid, supabaseUrl, serviceRoleKey], () => {
    response.status(503).setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Calendar feed is not configured.");
  })) return;

  const token = String(request.query?.token || "").trim();
  if (!token || token.length < 32 || token.length > 128) {
    response.status(400).setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Missing or invalid feed token.");
    return;
  }

  let resolved;
  try {
    resolved = await supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey, "get_calendar_feed_events", { p_token: token });
  } catch (error) {
    // Keep production diagnostics credential-free: status identifies gateway,
    // RPC, or network failures without logging the capability token or key.
    // Nothing DERIVED from the service-role key belongs here either — a length,
    // a "sb_secret_" prefix class, and a whitespace flag are each a confirmed
    // bit about a live credential, retained in logs that are read far more
    // widely than the key is. A misconfigured key still shows up as a 401/403
    // status, which is the diagnostic an operator can act on.
    console.error("Calendar feed RPC failed", {
      status: Number.isInteger(error?.status) ? error.status : null,
      reason: error?.name || "Error",
      cause: error?.cause?.code || null,
      supabaseHost: String(supabaseUrl).replace(/^https?:\/\//, "").split("/")[0],
    });
    response.status(503).setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Calendar feed is unavailable right now.");
    return;
  }
  if (!resolved?.valid) {
    response.status(404).setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Unknown or revoked calendar link.");
    return;
  }

  // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
  // feed owner's own private dates ride beside the events they RSVP'd to.
  const ics = buildIcsCalendar([
    ...(Array.isArray(resolved.events) ? resolved.events : []),
    ...personalDateEvents(resolved.personalDates),
  ]);
  response.status(200);
  response.setHeader("Content-Type", "text/calendar; charset=utf-8");
  // Per-member private content on a capability URL: no shared-cache storage.
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Disposition", 'inline; filename="unionground-events.ics"');
  response.end(ics);
}

// A private date as a calendar entry: its own id space, a 30-minute block at
// its time, the member's own note as the description, no location.
export function personalDateEvents(dates) {
  return (Array.isArray(dates) ? dates : [])
    .filter((date) => date && date.id && date.title && date.startsAt)
    .map((date) => ({ id: `personal-${date.id}`, title: date.title, startsAt: date.startsAt, location: "", summary: date.note || "", durationHours: 0.5 }));
}
