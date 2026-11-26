import { stewardHintCatalogueSpanish } from "./locales/es/namespaces/stewardHint.js";
// Steward ambient hints (REQ-UG-STEWARD-AMBIENT-HINTS-20261001), split out
// of the src/lib/i18n.js barrel like getApp.js. This file is the ONLY
// declaration of every `stewardHint.` key and of this record's `settings.def.`
// keys; the barrel spreads it back into `catalogue`, so `t()` is unchanged.
export const stewardHintCatalogue = {
  en: {
    "stewardHint.kicker": "Committee hint",
    "settings.def.features.home.steward_ambient_hints.label": "Committee ambient hints",
    "settings.def.features.home.steward_ambient_hints.description": "Show committee members one short hint from the organization's published learning library on the Committee desk overview.",
  },
  get es() { return stewardHintCatalogueSpanish; },
};
