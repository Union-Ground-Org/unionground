// The Q&A chrome is one register with the web app: these keys are declared
// once, under qa.*, and the barrel spreads the same chunk into `catalogue`.
// We import the NAMESPACE chunk rather than the barrel because this module is
// also apps/mobile's Q&A seam (apps/mobile/src/lib/mi1QaShared.ts re-exports
// it), and Metro cannot tree-shake the barrel's whole-catalogue module:
// importing t() from there shipped the whole web catalogue to the phone to
// resolve 60 strings (PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917).
// qaT is the barrel's own lookup bound to the qa.* table, so resolution,
// fallback and interpolation are identical.
import { qaT as t } from "../../lib/i18n/qa.js";

export function qaText(lang, key, vars = {}) {
  return t(lang, `qa.${key}`, vars);
}

// The key for a counted phrase: "votes" and "replies" have a ".one" form, so
// a single vote or reply never reads "1 votes" or "1 replies".
export function qaCountKey(key, count) {
  return count === 1 ? `${key}.one` : key;
}

export function qaStatusLabel(lang, status) {
  if (status === "open") return qaText(lang, "statusOpen");
  if (status === "replied") return qaText(lang, "statusReplied");
  if (status === "accepted") return qaText(lang, "statusAccepted");
  return status;
}

// fallbackKey: a write passes "writeUnconfirmed", so a failure with no known
// cause (a lost reply among them) never reads as questions failing to load
// (#9462, M2-17).
export function qaFailureText(lang, failure, translate = null, fallbackKey = "unavailable") {
  const text = (key) => translate ? translate(`qa.${key}`) : qaText(lang, key);
  // The two authorization gates requireActiveQaMember raises first are not
  // outages: "unauthenticated" means nobody is signed in and "membership_revoked"
  // means the membership this org once granted is no longer active. Both used to
  // fall through to qa.unavailable, which reads as "the service is broken" and
  // hides the one action that clears the gate
  // (UX-UG-QA-SIGNED-OUT-AND-REVOKED-GATES-READ-AS-AN-OUTAGE-20260920).
  if (failure?.code === "unauthenticated") return text("signInRequired");
  if (failure?.code === "membership_revoked") return text("membershipRevoked");
  if (failure?.code === "mfa_required") return text("mfaRequired");
  if (["organization_required", "chapter_required", "organization_scope_missing"].includes(failure?.code)) {
    return text("membershipRequired");
  }
  if (failure?.code === "forbidden") return text("forbidden");
  if (failure?.code === "conflict") return text("staleQuestion");
  if (failure?.code === "invalid_input"
    || /^(title|body|search)_too_(short|long)$/.test(String(failure?.code || ""))
    || ["invalid_text", "invalid_reply", "invalid_vote_target", "invalid_status", "invalid_sort"].includes(failure?.code)) {
    return text("invalidInput");
  }
  if (failure?.code === "not_found") return text("notFound");
  return text(fallbackKey);
}
