// REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: booking
// hours' title, location, audience note and first date, and a steward's
// private note on each booking
// (supabase/migrations/20261030234501_personal_reminders_booking_details_and_notes.sql).
import { MemberApiError } from "./memberApi.js";

function unwrap(result, operation) {
  if (result?.error) throw new MemberApiError(operation, { ...result.error, message: result.error.message || "request failed" });
  return result?.data;
}

// The time zones offered for booking hours: [IANA id, catalogue key], the
// same list Settings offers for focus hours. The id is what is stored.
export const BOOKING_TIME_ZONES = Object.freeze([
  ["America/New_York", "settings.zoneNewYork"],
  ["America/Chicago", "settings.zoneChicago"],
  ["America/Denver", "settings.zoneDenver"],
  ["America/Phoenix", "settings.zonePhoenix"],
  ["America/Los_Angeles", "settings.zoneLosAngeles"],
  ["America/Anchorage", "settings.zoneAnchorage"],
  ["Pacific/Honolulu", "settings.zoneHonolulu"],
  ["America/Puerto_Rico", "settings.zonePuertoRico"],
  ["America/Detroit", "settings.zoneDetroit"],
  ["America/Indiana/Indianapolis", "settings.zoneIndianapolis"],
]);

export async function loadScheduleDetails(client, stewardIds = null) {
  const rows = unwrap(await client.rpc("get_appointment_schedule_details", { p_steward_ids: stewardIds }), "Booking hours details");
  return Array.isArray(rows) ? rows : [];
}

export async function saveScheduleDetails(client, { title = "", location = "", audience = "", startsOn = "" } = {}) {
  return unwrap(await client.rpc("set_appointment_schedule_details", {
    p_title: String(title ?? "").trim() || null,
    p_location: String(location ?? "").trim() || null,
    p_audience: String(audience ?? "").trim() || null,
    p_starts_on: startsOn || null,
  }), "Booking hours details");
}

export async function loadAppointmentNotes(client, appointmentIds) {
  if (!appointmentIds?.length) return new Map();
  const rows = unwrap(await client.rpc("get_appointment_notes", { p_appointment_ids: appointmentIds.slice(0, 200) }), "Booking notes");
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [row.appointmentId, row.note]));
}

export async function saveAppointmentNote(client, appointmentId, note) {
  return unwrap(await client.rpc("set_appointment_note", {
    p_appointment_id: appointmentId,
    p_note: String(note ?? "").trim() || null,
  }), "Booking note");
}
