// REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: a
// member's own reminders and private dates. One-off or repeating (daily,
// weekly, monthly), delivered in the app by the server
// (supabase/migrations/20261030234501_personal_reminders_booking_details_and_notes.sql);
// they also appear in the member's own calendar feed.
import { MemberApiError } from "../../lib/memberApi.js";

export const PERSONAL_REPEATS = Object.freeze(["none", "daily", "weekly", "monthly"]);

function unwrap(result, operation) {
  if (result?.error) throw new MemberApiError(operation, { ...result.error, message: result.error.message || "request failed" });
  return result?.data;
}

export async function listPersonalReminders(client, cursor = null, limit = 20) {
  const data = unwrap(await client.rpc("list_personal_reminders", {
    p_after_remind_at: cursor?.remindAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: limit,
  }), "Load reminders");
  return { items: Array.isArray(data?.items) ? data.items : [], nextCursor: data?.nextCursor ?? null };
}

// The member's own zone, so a repeat keeps the same local time across
// daylight-saving changes.
function memberTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export async function savePersonalReminder(client, { id = null, title, note = "", remindAt, repeat = "none", timeZone = memberTimeZone() }) {
  return unwrap(await client.rpc("save_personal_reminder", {
    p_id: id,
    p_title: String(title ?? "").trim(),
    p_note: String(note ?? "").trim(),
    p_remind_at: remindAt,
    p_repeat: PERSONAL_REPEATS.includes(repeat) ? repeat : "none",
    p_time_zone: timeZone,
  }), "Save reminder");
}

export async function cancelPersonalReminder(client, id) {
  return unwrap(await client.rpc("cancel_personal_reminder", { p_id: id }), "Cancel reminder");
}
