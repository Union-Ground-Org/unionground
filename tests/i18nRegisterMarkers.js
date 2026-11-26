// One formal-register marker source for Spanish catalogue checks.
//
// Boundaries are a Unicode letter class, not `\b`. `\b` is ASCII-only, so
// `\bdé\b` never matches `Dé` and `\ble\b` matches inside `leí`.
//
// `su` / `sus` / `le` / `les` stay on the QA scan. They are not part of the
// casework and admin family census: admin.command.lifecycleAccountHelp uses
// third-person `su` ("su propia exportación") and is not reader address.
// That census's only exact-string exemption is the impersonal "que se complete"
// in caseBulk.advanceOutcomeHelp, asserted by the caller.

export const SPANISH_LETTER_CLASS = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ";

export const USTED_PRONOUNS = Object.freeze([
  "usted", "ustedes", "su", "sus", "le", "les",
]);

// The formal imperatives the casework/admin census must detect. Listed once; the full
// imperative set spreads them so a test file is not a second copy.
export const CASEWORK_ADMIN_FORMAL_IMPERATIVES = Object.freeze([
  "elija", "emita", "explore", "filtre", "administre", "revoque",
  "asigne", "reemplace", "responda",
]);

// Historical QA imperatives, then the casework/admin ones above.
export const FORMAL_IMPERATIVES = Object.freeze([
  "pregunte", "publique", "envíe", "busque", "haga", "dé", "escriba", "añada",
  "vuelva", "inténtelo", "seleccione", "complete", "revise", "ingrese", "recargue",
  ...CASEWORK_ADMIN_FORMAL_IMPERATIVES,
]);

// Formal imperatives from the casework hub and Case tools file-private es COPY
// tables (UX-UG-CASEWORK-PANEL-ES-USTED-COPY-TABLES-20260920). Kept out of
// FORMAL_IMPERATIVES so the catalogue scans above do not widen: `cree` is also
// "believes" and `siga`/`pida` are ordinary subjunctives in catalogue prose.
// A register census that reads those panels can adopt this list unchanged.
export const CASEWORK_PANEL_FORMAL_IMPERATIVES = Object.freeze([
  "siga", "vincule", "empiece", "cree", "analice", "aplique", "actualice",
  "califique", "pida",
]);

function markersFor(words) {
  const alternation = [...words].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(
    `(?<![${SPANISH_LETTER_CLASS}])(?:${alternation})(?![${SPANISH_LETTER_CLASS}])`,
    "i",
  );
}

export const FORMAL_IMPERATIVE_MARKERS = markersFor(FORMAL_IMPERATIVES);

// QA chrome and the Be Heard door: pronouns plus formal imperatives.
export const USTED_MARKERS = markersFor([...USTED_PRONOUNS, ...FORMAL_IMPERATIVES]);

// caseDash.* / caseBulk.* / admin.command.*. `usted` catches reader address
// that is not an imperative ("que usted puede ver"). Possessive `su` is omitted
// so third-person "su propia" is not a second exemption.
export const CASEWORK_ADMIN_REGISTER_MARKERS = markersFor([
  "usted", "ustedes",
  ...FORMAL_IMPERATIVES,
]);

// UX-UG-ES-USTED-CENSUS-TIER2-20260917: the two tiers of the catalogue.es
// census (scripts/census-es-usted.mjs). Tier 1 is usted/ustedes plus the
// formal-imperative union the catalogue scans use; tier 2 is keys that match
// only the possessive/object pronouns, triaged by hand in the census inventory.
// The casework-panel list stays out for the same reason it stays out of
// FORMAL_IMPERATIVES.
export const TIER1_WORDS = Object.freeze([
  ...USTED_PRONOUNS.filter((word) => word.startsWith("usted")),
  ...FORMAL_IMPERATIVES,
]);
export const TIER2_WORDS = Object.freeze(USTED_PRONOUNS.filter((word) => !word.startsWith("usted")));
export const TIER1_MARKERS = markersFor(TIER1_WORDS);
export const TIER2_MARKERS = markersFor(TIER2_WORDS);

// The casework panels' es COPY tables: reader-address pronouns plus every
// formal imperative. Possessive `su` is omitted as in the census above.
export const CASEWORK_PANEL_REGISTER_MARKERS = markersFor([
  "usted", "ustedes",
  ...FORMAL_IMPERATIVES,
  ...CASEWORK_PANEL_FORMAL_IMPERATIVES,
]);
