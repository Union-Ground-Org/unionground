import { seededLabelsCatalogueSpanish } from "./locales/es/namespaces/seededLabels.js";
// Names the database seeds in English (REQ-UG-SPANISH-COVERAGE-AND-LANGUAGE-CARRYOVER-20261030):
// the default reward tiers (member_reward_tiers) and the default role line
// (member_profiles.role_line). src/lib/seededLabels.js shows these in the
// reader's language while a row still carries the seeded English name; a
// name an organization or member typed is shown as written. This file is the
// ONLY declaration of every `seededLabels.` key; the barrel spreads it back
// into `catalogue`, so `t()` is unchanged.
export const seededLabelsCatalogue = {
  en: {
    "seededLabels.roleLine.member": "Worker",
    "seededLabels.tier.member": "Worker",
    "seededLabels.tier.backer": "Backer",
    "seededLabels.tier.organizer": "Organizer",
    "seededLabels.tier.stewardReady": "Committee member-Ready",
    "seededLabels.tier.architect": "Architect",
  },
  get es() { return seededLabelsCatalogueSpanish; },
};
