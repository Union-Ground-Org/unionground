// SEC-UG-NON-INTERFERENCE-UNREACHED-FUNCTIONS-NEED-VALID-PROBES-20261111 .
// Some functions sort a whole population and return only its first rows (a
// limit, a page or a cursor). The proof compares such an answer exactly, but
// a cut answer depends on how many people or rows the fixture has: when a
// cohort grows, the row that makes a pinned difference (or would show a
// leak) is pushed past the cut and the comparison silently changes. Lane
// C330's run 5 lost the list_channel_mention_candidates pin that way.
//
// Each entry names one such function and says when its answer may have been
// cut. An entry with `every` is checked on every call (a measured run showed
// no call near its cap, or its probe searches a word only a few fixture
// people carry); otherwise only the calls a shared.json pin names, whose
// difference must be computed on a complete answer. A cut answer fails the proof by
// name instead of a pin disappearing or a leak hiding. An entry with
// `measure` is only counted (capMeasure, written to the report on every run)
// until its numbers decide whether it can be guarded;
// none is measure-only today.
const cut = (cap) => (rows) => Array.isArray(rows) && rows.length >= cap;
// A page whose rows or total is missing cannot show that it is complete, so it
// counts as cut.
const shortPage = (page, rows = "rows") => !page || !Array.isArray(page[rows]) || typeof page.total !== "number"
  || page[rows].length < page.total;

// The word the two channel-member probes search for (config/non-interference/
// probes.json). Only the own unit's and the neighbour unit's people carry it
// as a name word; the second chapter's and the neighbour organization's
// people carry CHANNEL_SEARCH_MARK, which it matches both as a word start
// (list_channel_mention_candidates) and as a substring
// (search_chapter_space_members), so a person leak shows in every pair
export const CHANNEL_SEARCH_WORD = "unit";
export const CHANNEL_SEARCH_MARK = "Unitsearch";

export const CAPPED_ANSWERS = Object.freeze({
  // 20261113143500: limit least(greatest(p_limit, 1), 10), sorted by name.
  list_channel_mention_candidates: { every: true, cut: (answer) => cut(10)(answer) },
  // 20261113143500: limit least(greatest(p_limit, 1), 50); the probe asks for 25.
  search_chapter_space_members: { every: true, cut: (answer) => cut(25)(answer) },
  // 20261001020000: lim + 1 rows by name; a further page leaves a nextCursor.
  list_member_event_organizer_candidates: { every: true, cut: (answer) => answer?.nextCursor != null },
  // 20260924230000: one page of p_page_size by name, with the full total.
  mi1_get_automation_scope_options: { every: true, cut: (answer) => ["chapters", "assignees", "recipients"].some((list) => shortPage(answer?.[list])) },
  // 20260826155000: limit 50.
  list_member_qa_questions: { every: true, cut: (answer) => cut(50)(answer) },
  // 20261003030000: limit 50.
  mi1_get_automation_routing_rules: { every: true, cut: (answer) => cut(50)(answer?.rules) },
  // 20261112214700: definitions limit 100, runs limit 50.
  mi1_get_automation_workspace: { every: true, cut: (answer) => cut(100)(answer?.definitions) || cut(50)(answer?.runs) },
  // 20260925610400: limit 8 trigger kinds by candidate count.
  mi1_get_automation_opportunities: { every: true, cut: (answer) => cut(8)(answer?.rows) },
  // Capped probes with no pin. Caps are the product's, with the
  // probe's own arguments (probes.json). Measured over every key first
  // (capMeasure, Lenovo run of unit 2): no call of any function in
  // this list was cut, so each is guarded on every call; the six above were
  // promoted from pinned calls only on the same numbers.
  // 20261104111500: p_limit (probe 20) + 1 rows; hasMore when cut.
  get_member_message_replies: { every: true, cut: (answer) => answer?.hasMore !== false },
  // 20261001020000: least(p_limit, 50) (probe 25) + 1 rows; nextCursor when cut.
  list_connected_workflow_recipients: { every: true, cut: (answer) => answer?.nextCursor != null },
  // 20261102005607 with 20260917090000 audit_sink_read_bounds: least(p_limit, 200) (probe 50).
  list_casework_audit_events: { every: true, cut: (answer) => cut(50)(answer) },
  list_coordinator_case_audit: { every: true, cut: (answer) => cut(50)(answer) },
  list_member_case_assignment_audit: { every: true, cut: (answer) => cut(50)(answer) },
  // 20261104111500: least(p_limit, 100) (probe 50) + 1 rows; nextCursor when cut.
  list_member_event_contact_messages: { every: true, cut: (answer) => answer?.nextCursor != null },
  // 20261113115000: least(p_limit, 200) (probe 50) + 1 rows; nextCursor when cut.
  list_chapter_seniority: { every: true, cut: (answer) => answer?.nextCursor != null },
  // 20261113115000: least(p_limit, 500) (probe 50) at an offset, with the total.
  list_chapter_bid_window_bids: { every: true, cut: (answer) => shortPage(answer, "bids") },
  // 20261112214700: one page of p_page_size (probe 20), with the total.
  mi1_get_automation_runs: { every: true, cut: (answer) => shortPage(answer) },
  // 20260830160000: p_limit (probe 10) + 1 rows; nextCursor when cut.
  list_welcome_campaign_enrollments: { every: true, cut: (answer) => answer?.nextCursor != null },
  // 20261112185547: pages of 25 of the public union catalog, total capped at 1000.
  search_union_catalog_by_country: { every: true, cut: (answer) => shortPage(answer) },
});

const parseKey = (key) => {
  const [pair, persona, target = "", variant] = key.split("|");
  const [kind, signature = ""] = target.split(/:(.*)/s);
  return { pair, persona, kind, name: signature.replace(/\(.*$/s, ""), variant };
};

const pinned = (shared, { pair, persona, name, variant }) => (shared?.functions?.[name]?.differences ?? [])
  .some((pin) => pin.pair === pair && (pin.personas ?? []).includes(persona) && (pin.variants ?? []).includes(variant));

// The keys of every observed answer the product may have cut, sorted. `sweeps`
// are the proof's maps of key -> observation; `shared` is shared.json.
export function cutAnswers(sweeps, shared, capped = CAPPED_ANSWERS) {
  const found = new Set();
  for (const map of sweeps) {
    for (const [key, seen] of map) {
      const at = parseKey(key);
      const rule = at.kind === "function" ? capped[at.name] : null;
      if (!rule || rule.measure || seen?.kind !== "ok") continue;
      if (!rule.every && !pinned(shared, at)) continue;
      const rows = Array.isArray(seen.value) ? seen.value : [];
      if (rows.some((row) => rule.cut(row?.[at.name]))) found.add(key);
    }
  }
  return [...found].sort();
}

// Report only: for every listed function, how many answered calls the proof
// made and which of them the product may have cut, over every key (not only
// the guarded ones), so a guard is added only where the numbers allow it.
export function capMeasure(sweeps, capped = CAPPED_ANSWERS) {
  const out = {};
  for (const map of sweeps) {
    for (const [key, seen] of map) {
      const at = parseKey(key);
      const rule = at.kind === "function" ? capped[at.name] : null;
      if (!rule) continue;
      const entry = (out[at.name] ??= { calls: 0, answered: 0, cut: [] });
      entry.calls += 1;
      if (seen?.kind !== "ok") continue;
      entry.answered += 1;
      const rows = Array.isArray(seen.value) ? seen.value : [];
      if (rows.some((row) => rule.cut(row?.[at.name]))) entry.cut.push(key);
    }
  }
  for (const entry of Object.values(out)) entry.cut = [...new Set(entry.cut)].sort();
  return out;
}
