// GENERATED FILE — do not edit by hand.
// Run `npm run sync:messaging-contract` after changing the migrations below.
// Source of truth:
//   reactionKinds: supabase/migrations/20261001010000_recovered_message_reaction_artwork.sql
//   redactionReasons: supabase/migrations/20260907121000_member_message_body_lifecycle.sql
//   retention: supabase/migrations/20260907121000_member_message_body_lifecycle.sql
//
// Every messaging rule the database owns lands here once, and both clients read
// it from here. A client that hard-codes one of these lists again fails
// tests/messaging-shared-contract.test.js.

export const MESSAGE_REACTION_KINDS = Object.freeze([
  "like",
  "support",
  "celebrate",
  "solidarity",
  "strength",
  "seen",
  "agreed",
  "care",
  "grievance",
  "victory",
]);

export const MESSAGE_REDACTION_REASONS = Object.freeze([
  "sender_removed",
  "staff_removed",
  "retention_expired",
  "account_closed",
]);

export const MESSAGE_BODY_RETENTION = Object.freeze({
  dataClass: "member_message_bodies",
  label: "Direct message bodies",
  minimumDays: 365,
  maximumDays: 2555,
  defaultDays: 1095,
  operation: "redact",
});
