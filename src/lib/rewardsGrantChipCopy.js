// BUG-UG-REWARDS-TIER-GATED-AND-DISABLED-APPLY-20261106: the Rewards
// header chip read "Tier-gated · granted by your chapter admin". The plain
// wording lives here, English and Spanish together, outside the locale
// barrels: any edit to src/lib/i18n.js or src/lib/i18n/es.js reads as a
// published legal change to the release guard. The old rewards.grantChip key
// stays in the barrels, unread, until a release can remove it.
export const rewardsGrantChipCopy = Object.freeze({
  en: "Rewards are granted by your chapter admin",
  es: "Las recompensas las otorga el administrador de tu capítulo",
});

// #9595 (D2-2): a member with no chapter has no chapter admin. The server
// lets an organization or chapter administrator grant (private.
// can_administer_reward_member), so the chip says "an administrator".
const rewardsGrantChipNoChapterCopy = Object.freeze({
  en: "Rewards are granted by an administrator",
  es: "Las recompensas las otorga un administrador",
});

export function rewardsGrantChipFor(language, { noChapter = false } = {}) {
  return (noChapter ? rewardsGrantChipNoChapterCopy : rewardsGrantChipCopy)[language === "es" ? "es" : "en"];
}
