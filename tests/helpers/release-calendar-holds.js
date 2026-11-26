// REQ-UG-HOLD-RELEASE-CALENDAR-SWITCHES-20261112 (#8579).
//
// 20261112214700_hold_release_calendar_switches.sql holds these switches with
// no date, so on Main each reads off for every organization whatever its
// stored value. A database proof of one of these features' own behavior
// releases them inside its own open transaction, which it rolls back; the hold
// itself is proven by tests/feature-switches-release-hold-db.test.js.
export const RELEASE_CALENDAR_HELD_KEYS = Object.freeze([
  "features.ai_assistant.field_notes_packet",
  "features.attention.dashboard",
  "features.attention.guided_portal",
  "features.attention.member_surfaces",
  "features.attention.navigation",
  "features.automation.default_recipes",
  "features.civic.watchlist",
  "features.engagement_voice.bargaining_survey_template",
  "features.intelligence.neuro_map",
  "features.intelligence.neuro_map_auto_progress",
  "features.intelligence.neuro_map_derived_graph",
  "features.intelligence.weekly_digest",
  "features.intelligence.weekly_digest_ai",
  "features.member_invitations.enabled",
  "features.security.member_pin_signin",
  "features.security.sso",
  "features.tasks.coop_checkoff_lists",
]);

// Call only inside a transaction the proof rolls back.
export function releaseCalendarHolds(client) {
  return client.query(
    "update public.platform_setting_definitions set release_at = null where key = any($1::text[])",
    [RELEASE_CALENDAR_HELD_KEYS],
  );
}
