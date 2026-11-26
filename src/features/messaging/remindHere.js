// /remind here (REQ-UG-REMIND-HERE-20261001). One client for web
// (src/App.jsx messagingApi) and native (apps/mobile/app/channel/[id].tsx,
// apps/mobile/app/reminders.tsx). The database is the authority:
// public.create_channel_here_reminder re-checks the organization switch, the
// caller's campaign staff standing and that they can post in the channel, and
// public.list_channel_here_reminders re-checks the reader's access every time.

export const REMIND_HERE_SWITCH = "features.messaging.remind_here";

/**
 * @param {{ rpc: Function }} client
 * @param {{ spaceId: string, remindAt: string, note: string }} input
 * @returns {Promise<{ id: string, remindAt: string, coalesced: boolean }>}
 */
export async function createChannelHereReminder(client, { spaceId, remindAt, note }) {
  if (!client || typeof spaceId !== "string" || !spaceId) throw Object.assign(new Error("Channel unavailable."), { code: "42501" });
  const { data, error } = await client.rpc("create_channel_here_reminder", {
    p_space_id: spaceId,
    p_remind_at: remindAt,
    p_note: note,
  });
  if (error) throw error;
  if (!data || typeof data.id !== "string") throw new Error("Reminder was not confirmed.");
  return { id: data.id, remindAt: String(data.remindAt ?? remindAt), coalesced: data.coalesced === true };
}

/**
 * @typedef {{ id: string, note: string, remindAt: string | null, deliveredAt: string | null,
 *   spaceId: string | null, spaceName: string, authorName: string, mine: boolean }} ChannelHereReminder
 */

/** @returns {ChannelHereReminder | null} */
function normalizeChannelReminder(row) {
  if (!row || typeof row.id !== "string" || typeof row.note !== "string") return null;
  return {
    id: row.id,
    note: row.note,
    remindAt: row.remindAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    spaceId: typeof row.spaceId === "string" ? row.spaceId : null,
    spaceName: typeof row.spaceName === "string" ? row.spaceName : "",
    authorName: typeof row.authorName === "string" ? row.authorName : "",
    mine: row.mine === true,
  };
}

/**
 * Channel reminders that reached the caller as channel staff (last 30 days).
 * @param {{ rpc: Function }} client
 * @returns {Promise<ChannelHereReminder[]>}
 */
export async function listChannelHereReminders(client, limit = 50) {
  if (!client) return [];
  const { data, error } = await client.rpc("list_channel_here_reminders", { p_limit: limit });
  if (error) throw error;
  return normalizeChannelReminders(data);
}

/**
 * The RPC's rows, malformed ones dropped. The web member loader reads the same
 * RPC as boot data for Messages.
 * @returns {ChannelHereReminder[]}
 */
export function normalizeChannelReminders(data) {
  /** @type {ChannelHereReminder[]} */
  const rows = [];
  for (const row of Array.isArray(data) ? data : []) {
    const item = normalizeChannelReminder(row);
    if (item) rows.push(item);
  }
  return rows;
}

/**
 * One reason code for a refused create, so each client can say why.
 * @returns {'off' | 'staff' | 'limit' | 'invalid' | 'unavailable' | 'failed'}
 */
export function remindHereRefusal(error) {
  const code = String(error?.code ?? "");
  const detail = String(error?.details ?? error?.detail ?? "");
  if (code === "42501" && detail === "feature-disabled") return "off";
  if (code === "42501" && detail === "staff-required") return "staff";
  if (code === "42501") return "unavailable";
  if (code === "54000") return "limit";
  if (code === "22023") return "invalid";
  return "failed";
}

const REFUSAL_TEXT_EN = Object.freeze({
  off: "Channel staff reminders are turned off for your organization.",
  staff: "Only campaign staff can remind this channel's staff.",
  unavailable: "This channel is not available for reminders.",
  limit: "You have reached the reminder limit for this channel.",
  invalid: "Pick a time within the next year and a note of up to 500 characters.",
  failed: "The reminder could not be set. Try again.",
});

/** English refusal text (native is English-only; web localizes by code). */
export function remindHereRefusalTextEn(reason) {
  return REFUSAL_TEXT_EN[reason] ?? REFUSAL_TEXT_EN.failed;
}
