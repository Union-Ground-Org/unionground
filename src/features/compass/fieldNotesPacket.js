// REQ-UG-FIELD-NOTES-AI-PACKET-20261001
//
// "Draft a packet" on the field notes view (old de7df4b57c^
// components/field-notes/field-notes-studio.tsx over
// app/api/field-notes/draft-packet/route.ts). These helpers only keep the
// control honest: the server enforces both switches and the note limit, and
// re-reads every note through the caller's own chapter scope.
import { featureLimit, isFeatureEnabled } from "../../lib/featureSwitches.js";

// The route's own hard ceiling, matching limits.ai_assistant.packet_notes'
// maximum in supabase/migrations/20261009230000_field_notes_ai_packet.sql.
export const PACKET_NOTES_CEILING = 24;
export const PACKET_NOTES_DEFAULT = 12;

export function fieldNotesPacketEnabled(configuration) {
  return Boolean(configuration && typeof configuration === "object")
    && isFeatureEnabled(configuration, "features.ai_assistant.enabled", true)
    && isFeatureEnabled(configuration, "features.ai_assistant.field_notes_packet", false);
}

export function fieldNotesPacketNoteLimit(configuration) {
  const limit = featureLimit(configuration, "limits.ai_assistant.packet_notes", PACKET_NOTES_DEFAULT);
  return Math.min(Math.max(Number.isInteger(limit) ? limit : PACKET_NOTES_DEFAULT, 1), PACKET_NOTES_CEILING);
}
