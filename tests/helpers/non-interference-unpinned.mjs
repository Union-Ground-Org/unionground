// SEC-UG-NON-INTERFERENCE-UNREACHED-FUNCTIONS-NEED-VALID-PROBES-20261111 (#8359).
// The record entries of config/non-interference/expected-differences.json that
// may still go unpinned while their fix pull requests wait on the migration
// line (production controller ruling of Nov 15, 2026, 12:12 PM ET). Any other
// unpinned record entry fails the proof and the list check. An allowed name
// that has already left the config is no failure. Its name is deleted from
// this list by the next #8359 batch after its fix merges: #8850 after #8863.
//
// Each allowed entry is frozen to its pairs and functions (review of #8874,
// ledger 315 P3-1): while it is unpinned, the list check fails if the
// config's entry names any other pair or function, so neither can grow
// unseen. #8795 left this list in #8359 batch 14: it is pinned instead (review
// of #8880, P1-1), with its chapter and unit pins naming only
// casework_request_deadline_extension.
export const UNPINNED_RECORDS_ALLOWED = Object.freeze({
  "#8850": Object.freeze({
    pairs: Object.freeze(["unit"]),
    functions: Object.freeze(["search_chapter_space_members", "list_channel_mention_candidates"]),
  }),
});

// The unpinned record entries a verdict reports beyond the allowed ones.
export const unpinnedBeyondAllowed = (unpinnedRecords, allowed = UNPINNED_RECORDS_ALLOWED) =>
  unpinnedRecords.filter((record) => !Object.hasOwn(allowed, record));

// Whether an unpinned record entry is exactly the one the allow list froze:
// the same pairs and functions (in any order) and no tables.
export function matchesFrozen(record, entry, allowed = UNPINNED_RECORDS_ALLOWED) {
  const frozen = allowed[record];
  const same = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  return Boolean(frozen) && same(entry.pairs, frozen.pairs) && same(entry.functions, frozen.functions) && !(entry.tables ?? []).length;
}
