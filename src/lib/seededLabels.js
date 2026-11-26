// The reward tier names and the role line the database seeds in English
// (supabase/migrations/20260721223851_member_rewards_and_ballot_receipts.sql,
// 20260925620700_member_profiles_role_line_neutral_default.sql). While a row
// still carries the seeded name it is shown in the reader's language; any
// other name was typed by an organization or a member and is shown as written.
const TIER_KEYS = new Map([
  ["Member", "seededLabels.tier.member"],
  ["Backer", "seededLabels.tier.backer"],
  ["Organizer", "seededLabels.tier.organizer"],
  ["Steward-Ready", "seededLabels.tier.stewardReady"],
  ["Architect", "seededLabels.tier.architect"],
]);
const ROLE_LINE_KEYS = new Map([["Member", "seededLabels.roleLine.member"]]);

function seeded(keys, value, t) {
  const key = typeof value === "string" ? keys.get(value.trim()) : undefined;
  return key ? t(key) : value;
}

export const seededTierName = (name, t) => seeded(TIER_KEYS, name, t);
export const seededRoleLine = (roleLine, t) => seeded(ROLE_LINE_KEYS, roleLine, t);
