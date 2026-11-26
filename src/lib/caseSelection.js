// Shared multi-select model for every casework list (lane 5.6). The
// coordinator queue and the steward caseload render different cards, so the
// model is deliberately pure data: an ordered array of case ids plus the
// derived answers a bulk bar needs. Lane 5.2's TanStack list can adopt it by
// passing its own visible-row ids without importing any card markup.
//
// Order is preserved because the bulk bar reports failures per case and an
// arbitrary Set iteration order would reshuffle that report between renders.

// casework_bulk_update_cases raises 22023 outside 1..100, so the client caps
// at the same number rather than letting the server reject a whole batch.
export const SELECTION_LIMIT = 100;

function normalize(selection) {
  return Array.isArray(selection) ? selection.filter(Boolean) : [];
}

export function isSelected(selection, id) {
  return normalize(selection).includes(id);
}

// Toggling ON past the cap is refused rather than silently dropping the
// oldest id: a coordinator who ticked 101 boxes must see which one failed.
export function toggleSelection(selection, id) {
  const current = normalize(selection);
  if (!id) return current;
  if (current.includes(id)) return current.filter((entry) => entry !== id);
  if (current.length >= SELECTION_LIMIT) return current;
  return [...current, id];
}

// Select-all-visible is bounded by the same cap and keeps the list's order,
// so "advance 100 cases" reads down the queue the coordinator is looking at.
export function selectVisible(selection, visibleIds) {
  const current = normalize(selection);
  const seen = new Set(current);
  const next = [...current];
  for (const id of visibleIds || []) {
    if (!id || seen.has(id)) continue;
    if (next.length >= SELECTION_LIMIT) break;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function clearVisible(selection, visibleIds) {
  const hidden = new Set(visibleIds || []);
  return normalize(selection).filter((id) => !hidden.has(id));
}

export function clearSelection() {
  return [];
}

// A filter change, a page reload, or a resolved case can retire a row while
// it is still ticked. Pruning against the rows actually in hand stops the bar
// from submitting an id the viewer can no longer see.
//
// When nothing is pruned the SAME array comes back, not an equal copy. Both
// desks prune inside a React state updater keyed on a derived id list, and a
// desk loader that hands back a fresh caseload array on every render makes
// that key change on every render too. An updater that always returned a new
// array therefore scheduled a render on every render — an unbreakable loop
// that hung the steward desk and, with it, every suite that mounts it.
// Returning the input lets React's bail-out stop the cycle at the first pass.
export function pruneSelection(selection, availableIds) {
  const current = normalize(selection);
  const available = new Set(availableIds || []);
  const pruned = current.filter((id) => available.has(id));
  if (pruned.length === current.length) return Array.isArray(selection) ? selection : current;
  return pruned;
}

export function selectedRows(rows, selection) {
  const chosen = new Set(normalize(selection));
  return (rows || []).filter((row) => chosen.has(row?.id));
}

// casework_bulk_update_cases takes ONE p_expected_status for the batch and
// raises 40001 when any row drifts from it. Mixed selections therefore cannot
// set status; the bar disables that control instead of sending a request that
// is guaranteed to fail.
export function sharedStatus(rows) {
  const statuses = new Set((rows || []).map((row) => row?.status).filter(Boolean));
  return statuses.size === 1 ? [...statuses][0] : null;
}


export function selectionState(selection, visibleIds = []) {
  const current = normalize(selection);
  const visible = (visibleIds || []).filter(Boolean);
  const chosen = new Set(current);
  const selectedVisible = visible.filter((id) => chosen.has(id)).length;
  return {
    count: current.length,
    limit: SELECTION_LIMIT,
    atLimit: current.length >= SELECTION_LIMIT,
    visibleCount: visible.length,
    selectedVisible,
    allVisible: visible.length > 0 && selectedVisible === visible.length,
    someVisible: selectedVisible > 0 && selectedVisible < visible.length,
  };
}
