// Recorded acceptance of the versioned legal instruments, web client side.
//
// of October 10, 2026 (option a):
// "versioned clickwrap at invitation acceptance and at first sign-in after a
// material change, recording version, time, user and organization; until it
// ships, the pack is not published as operative."
//
// The database owns the record. public.get_my_legal_acceptance_state answers
// only for the caller, public.record_legal_acceptance writes only for the
// caller, and api/accept-invitation.js records the invitation clickwrap
// through the service-role function, so the stored version, time, person and
// organization never come from a client claim.
// src/lib/legalInstruments.js stays the one version source.
import {
  LEGAL_INSTRUMENTS,
  currentLegalVersions,
  latestMaterialLegalVersion,
  legalChangeNotice,
} from "./legalInstruments.js";
import { isResidenceRegion } from "./residenceRegions.js";

// Whether the apps need to ask the server about acceptance at all. Until a
// published change is marked material in src/lib/legalInstruments.js nothing
// can require re-acceptance, so neither app spends a boot read on a question
// whose answer cannot change anything. Publishing the first material change
// turns this on and adds one cold-boot read: raise the pinned read count in
// tests/member-boot-round2.test.js in the same commit.
export function legalAcceptanceReadNeeded(instruments = LEGAL_INSTRUMENTS) {
  return instruments.some((entry) => latestMaterialLegalVersion(entry) !== null);
}

// The caller's own accepted versions, or null for "not known" — a failed or
// unavailable read must leave every prompt silent rather than tell a member
// they are behind on terms the product cannot prove anything about.
export async function loadLegalAcceptanceState(client) {
  if (!client) return null;
  try {
    const { data, error } = await client.rpc("get_my_legal_acceptance_state");
    if (error || !data || typeof data !== "object") return null;
    const versions = data.versions && typeof data.versions === "object" && !Array.isArray(data.versions)
      ? data.versions
      : {};
    return {
      versions,
      acceptedAt: typeof data.acceptedAt === "string" ? data.acceptedAt : null,
    };
  } catch {
    return null;
  }
}

// { instrumentKey: version } for the signed-in person, or null when unknown.
// The no-argument call is the pre-sign-in case and stays "not known".
export function recordedLegalAcceptances(state) {
  const versions = state?.versions;
  return versions && typeof versions === "object" && !Array.isArray(versions) ? versions : null;
}

// Whether this person must accept again before going on, from the same
// material-change flag the in-product notice reads.
export function legalAcceptanceRequirement(state, instruments) {
  return instruments
    ? legalChangeNotice(recordedLegalAcceptances(state), instruments)
    : legalChangeNotice(recordedLegalAcceptances(state));
}

// Records the caller's acceptance of the versions in force. The versions are
// read from the shared source here and checked again by the database, so a
// stale tab cannot record agreement to text it did not show. residenceState is
// the state the person chose (src/lib/residenceRegions.js) and ageAttested is
// their answer to the age attestation that state selects (owner decision of
// October 16, 2026). Nothing is sent without both, and the database derives
// which attestation was given from the state, not from this client.
export async function recordLegalAcceptance(client, versions = currentLegalVersions(), residenceState = "", ageAttested = false) {
  return await recordLegalAcceptanceOutcome(client, versions, residenceState, ageAttested) === "recorded";
}

// BUG-UG-TERMS-REACCEPTANCE-GATE-LOCKOUT-20261030: the website and
// the database pin of the versions in force (private.legal_acceptance_versions)
// ship separately: the site deploys at merge and the migration is applied to
// Production after it. On October 30, 2026 the site asked for privacy 1.3.0
// from 9:42 AM ET, while the database refused 1.3.0 as "legal versions not
// current" until 9:53 AM ET, and every member behind on terms was locked out.
// That refusal is a fact about this deployment, not about the member, so it is
// reported apart from an ordinary failure: "recorded", "unavailable" (the
// database does not hold the versions this site shows, in either direction)
// or "failed".
export const LEGAL_ACCEPTANCE_PACK_UNAVAILABLE = "legal versions not current";

export async function recordLegalAcceptanceOutcome(client, versions = currentLegalVersions(), residenceState = "", ageAttested = false) {
  if (!client || !isResidenceRegion(residenceState) || ageAttested !== true) return "failed";
  try {
    const { data, error } = await client.rpc("record_legal_acceptance", {
      p_versions: versions,
      p_residence_state: residenceState,
      p_age_attested: true,
    });
    if (error) return error.code === "22023" && error.message === LEGAL_ACCEPTANCE_PACK_UNAVAILABLE ? "unavailable" : "failed";
    return data?.recorded === true ? "recorded" : "failed";
  } catch {
    return "failed";
  }
}
