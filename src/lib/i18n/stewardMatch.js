import { stewardMatchCatalogueSpanish } from "./locales/es/namespaces/stewardMatch.js";
// Recommended and nearest steward (REQ-UG-RECOMMENDED-AND-NEAREST-STEWARD-20261001),
// split out of the src/lib/i18n.js barrel like ./caseworkUlp.js. This file is
// the ONLY declaration of every `stewardMatch.` key and of the matching
// setting labels; the barrel spreads it back into `catalogue`. Spanish follows
// the coordination panel's "delegado".
export const stewardMatchCatalogue = {
  en: {
    "stewardMatch.recommended": "Recommended committee contact: {name}",
    "stewardMatch.nearest": "No committee contact is scheduled right now. The nearest committee contact for you is {name}.",
    "stewardMatch.level.work_location": "Same work location",
    "stewardMatch.level.department": "Same department",
    "stewardMatch.level.chapter": "Your campaign",
    "stewardMatch.email": "Email {email}",
    "stewardMatch.phone": "Call {phone}",
    "stewardMatch.message": "You can also message them from Messages.",
    "settings.def.features.casework.nearest_steward_matching.label": "Nearest committee member matching",
    "settings.def.features.casework.nearest_steward_matching.description": "Prefer a committee member at the worker's work location or department when recommending one, and recommend the nearest committee member when none is scheduled.",
  },
  get es() { return stewardMatchCatalogueSpanish; },
};
