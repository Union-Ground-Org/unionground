// Where a person says they live, asked at every account-creation path and at
// re-acceptance, and the age rule that answer selects.
//
// about 12:50 PM ET (retained at
// 20261016-adults-only-app-store-states.md): Union Ground is adults-only (18
// and over) only for a person in one of the app-store age-law states named in
// section 4.2 of docs/security/state-privacy-law-applicability-counsel-draft-
// 20261012.md. Everywhere else the D-03 B band of October 10 applies: not
// directed to children under 13, and a person 13 to 17 only through an
// account their organization authorized and where law permits. The product
// learns the state by asking; the answer is recorded with the attestation.
//
// The web pages, the native app and the API routes all read this module, and
// supabase/migrations/20261016170000_app_store_states_age_rule.sql carries the
// same two lists, so the rule the person sees is the rule the server records.
// A change to either list is a terms change: move the terms version and the
// migration together.

const OUTSIDE_UNITED_STATES = "outside-us";

// Texas (SB 2420), California (AB 1043), Alabama (HB 161), Utah (SB 142 /
// HB 498) and Louisiana (HB 977).
const APP_STORE_AGE_LAW_STATES = Object.freeze(["TX", "CA", "AL", "UT", "LA"]);

// USPS codes for the 50 states, the District of Columbia and the five
// inhabited territories, then "outside the United States". English and
// Spanish names live here rather than in the catalogue because the native
// app reads the same list.
export const RESIDENCE_REGIONS = Object.freeze([
  ["AL", "Alabama", "Alabama"],
  ["AK", "Alaska", "Alaska"],
  ["AZ", "Arizona", "Arizona"],
  ["AR", "Arkansas", "Arkansas"],
  ["CA", "California", "California"],
  ["CO", "Colorado", "Colorado"],
  ["CT", "Connecticut", "Connecticut"],
  ["DE", "Delaware", "Delaware"],
  ["DC", "District of Columbia", "Distrito de Columbia"],
  ["FL", "Florida", "Florida"],
  ["GA", "Georgia", "Georgia"],
  ["HI", "Hawaii", "Hawái"],
  ["ID", "Idaho", "Idaho"],
  ["IL", "Illinois", "Illinois"],
  ["IN", "Indiana", "Indiana"],
  ["IA", "Iowa", "Iowa"],
  ["KS", "Kansas", "Kansas"],
  ["KY", "Kentucky", "Kentucky"],
  ["LA", "Louisiana", "Luisiana"],
  ["ME", "Maine", "Maine"],
  ["MD", "Maryland", "Maryland"],
  ["MA", "Massachusetts", "Massachusetts"],
  ["MI", "Michigan", "Míchigan"],
  ["MN", "Minnesota", "Minnesota"],
  ["MS", "Mississippi", "Misisipi"],
  ["MO", "Missouri", "Misuri"],
  ["MT", "Montana", "Montana"],
  ["NE", "Nebraska", "Nebraska"],
  ["NV", "Nevada", "Nevada"],
  ["NH", "New Hampshire", "Nuevo Hampshire"],
  ["NJ", "New Jersey", "Nueva Jersey"],
  ["NM", "New Mexico", "Nuevo México"],
  ["NY", "New York", "Nueva York"],
  ["NC", "North Carolina", "Carolina del Norte"],
  ["ND", "North Dakota", "Dakota del Norte"],
  ["OH", "Ohio", "Ohio"],
  ["OK", "Oklahoma", "Oklahoma"],
  ["OR", "Oregon", "Oregón"],
  ["PA", "Pennsylvania", "Pensilvania"],
  ["RI", "Rhode Island", "Rhode Island"],
  ["SC", "South Carolina", "Carolina del Sur"],
  ["SD", "South Dakota", "Dakota del Sur"],
  ["TN", "Tennessee", "Tennessee"],
  ["TX", "Texas", "Texas"],
  ["UT", "Utah", "Utah"],
  ["VT", "Vermont", "Vermont"],
  ["VA", "Virginia", "Virginia"],
  ["WA", "Washington", "Washington"],
  ["WV", "West Virginia", "Virginia Occidental"],
  ["WI", "Wisconsin", "Wisconsin"],
  ["WY", "Wyoming", "Wyoming"],
  ["AS", "American Samoa", "Samoa Estadounidense"],
  ["GU", "Guam", "Guam"],
  ["MP", "Northern Mariana Islands", "Islas Marianas del Norte"],
  ["PR", "Puerto Rico", "Puerto Rico"],
  ["VI", "U.S. Virgin Islands", "Islas Vírgenes de EE. UU."],
  [OUTSIDE_UNITED_STATES, "Outside the United States", "Fuera de Estados Unidos"],
].map(([code, en, es]) => Object.freeze({ code, en, es })));

const CODES = new Set(RESIDENCE_REGIONS.map((region) => region.code));

export function isResidenceRegion(value) {
  return typeof value === "string" && CODES.has(value);
}

// The region's name in the page language; Spanish names are part of the list.
export function residenceRegionName(code, lang = "en") {
  const region = RESIDENCE_REGIONS.find((entry) => entry.code === code);
  return region ? (lang === "es" ? region.es : region.en) : "";
}

// "adult" when the person must be 18 or older, "band" when the D-03 B band
// applies, null for anything that is not a listed region. Callers refuse null.
export function ageRuleFor(code) {
  if (!isResidenceRegion(code)) return null;
  return APP_STORE_AGE_LAW_STATES.includes(code) ? "adult" : "band";
}
