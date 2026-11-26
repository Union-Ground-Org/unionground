// Demo-hat mirrors of the steward desk list RPCs (UB-DESK-01) — the same
// filter/search/sort/keyset semantics as the SQL, expressed over the demo
// desk's in-memory rows, so the demo hat drives the REAL paged view unchanged
// (the filterCoordinatorFocus precedent). Pure functions, unit-tested.
//
// Cursors are the same shapes the real pagers hand around ({ createdAt, id },
// { updatedAt, id }, ...), and they are POSITIONS, not row identities: a row
// deleted mid-walk cannot break the walk, exactly like the SQL row
// comparison.

function normalized(value) {
  return String(value ?? "").toLocaleLowerCase();
}

function matchesSearch(fields, search) {
  const needle = normalized(search).trim();
  if (!needle) return true;
  return fields.some((field) => normalized(field).includes(needle));
}

// (timestamp, id) tuple order in OUTPUT order — the demo twin of the SQL
// "order by ts <dir> nulls last, id <dir>". Null timestamps sort LAST in
// both directions (sol F2: a bare string coalesce put them FIRST ascending,
// diverging from the SQL's NULLS LAST page boundaries); inside the null
// region ties break on id in the direction's own order, exactly like SQL.
function compareInOrder(a, b, descending) {
  const aNull = a.ts == null || a.ts === "";
  const bNull = b.ts == null || b.ts === "";
  if (aNull !== bNull) return aNull ? 1 : -1;
  if (!aNull && a.ts !== b.ts) return (String(a.ts) < String(b.ts) ? -1 : 1) * (descending ? -1 : 1);
  const ai = String(a.id ?? "");
  const bi = String(b.id ?? "");
  if (ai === bi) return 0;
  return (ai < bi ? -1 : 1) * (descending ? -1 : 1);
}

function pageRows(rows, { matches = () => true, keyOf, descending = true, cursorKey = null, limit }) {
  const filtered = rows.filter(matches);
  const sorted = [...filtered].sort((a, b) => compareInOrder(keyOf(a), keyOf(b), descending));
  const after = cursorKey
    ? sorted.filter((row) => compareInOrder(keyOf(row), cursorKey, descending) > 0)
    : sorted;
  const page = after.slice(0, limit);
  return {
    rows: page,
    nextKey: page.length < limit ? null : keyOf(page[page.length - 1]),
    total: filtered.length,
  };
}

export function pageStewardRequests(rows, { status = "all", search = "", sort = "newest", cursor = null, limit = 100 } = {}) {
  const page = pageRows(rows, {
    matches: (row) => (
      status === "all"
      || (status === "open" ? row.status !== "closed" : row.status === status)
    ) && matchesSearch([row.memberName], search),
    keyOf: (row) => ({ ts: row.createdAt, id: row.id }),
    descending: sort === "newest",
    cursorKey: cursor ? { ts: cursor.createdAt, id: cursor.id } : null,
    limit,
  });
  return {
    rows: page.rows,
    nextCursor: page.nextKey ? { createdAt: page.nextKey.ts, id: page.nextKey.id } : null,
    total: page.total,
  };
}

export function pageStewardThreads(rows, { filter = "all", search = "", cursor = null, limit = 50 } = {}) {
  const page = pageRows(rows, {
    matches: (row) => (filter === "all" || row.awaitingReply)
      && matchesSearch([row.memberName, row.title], search),
    keyOf: (row) => ({ ts: row.updatedAt, id: row.id }),
    descending: true,
    cursorKey: cursor ? { ts: cursor.updatedAt, id: cursor.id } : null,
    limit,
  });
  return {
    rows: page.rows,
    nextCursor: page.nextKey ? { updatedAt: page.nextKey.ts, id: page.nextKey.id } : null,
    total: page.total,
  };
}

export function pageStewardForms(rows, { status = "all", search = "", sort = "oldest", cursor = null, limit = 50 } = {}) {
  const page = pageRows(rows, {
    matches: (row) => (status === "all" || row.status === status)
      && matchesSearch([row.memberName], search),
    keyOf: (row) => ({ ts: row.submittedAt, id: row.id }),
    descending: sort === "newest",
    cursorKey: cursor ? { ts: cursor.submittedAt, id: cursor.id } : null,
    limit,
  });
  return {
    rows: page.rows,
    nextCursor: page.nextKey ? { submittedAt: page.nextKey.ts, id: page.nextKey.id } : null,
    total: page.total,
  };
}

export function pageStewardBroadcasts(rows, { filter = "all", search = "", cursor = null, limit = 20 } = {}) {
  const page = pageRows(rows, {
    matches: (row) => (
      filter === "all"
      || (filter === "active" ? !row.retracted : row.retracted)
    ) && matchesSearch([row.title, row.body], search),
    keyOf: (row) => ({ ts: row.publishedAt, id: row.id }),
    descending: true,
    cursorKey: cursor ? { ts: cursor.publishedAt, id: cursor.id } : null,
    limit,
  });
  return {
    rows: page.rows,
    nextCursor: page.nextKey ? { publishedAt: page.nextKey.ts, id: page.nextKey.id } : null,
    total: page.total,
  };
}

// Appointments panel lists (sol PR #734 F9). One twin, two walks: the caller
// hands in the LIST for the scope (the demo desk keeps upcoming and recent as
// separate arrays), and scope only picks the direction — upcoming ascends so
// ended-but-unmarked rows surface first, recent descends, exactly like
// list_steward_appointments. No search or filter, so total is rows.length.
export function pageStewardAppointments(rows, { scope = "upcoming", cursor = null, limit = 50 } = {}) {
  const page = pageRows(rows, {
    keyOf: (row) => ({ ts: row.startsAt, id: row.id }),
    descending: scope === "recent",
    cursorKey: cursor ? { ts: cursor.startsAt, id: cursor.id } : null,
    limit,
  });
  return {
    rows: page.rows,
    nextCursor: page.nextKey ? { startsAt: page.nextKey.ts, id: page.nextKey.id } : null,
    total: page.total,
  };
}

// Demo thread messages live chronological on the demo thread rows; the RPC
// walk runs backward, so the twin sorts descending, pages, then hands the
// window back chronological like loadStewardThreadMessages does.
export function pageStewardThreadMessages(messages, { cursor = null, limit = 50 } = {}) {
  const page = pageRows(messages, {
    keyOf: (row) => ({ ts: row.created_at, id: row.id }),
    descending: true,
    cursorKey: cursor ? { ts: cursor.createdAt, id: cursor.id } : null,
    limit,
  });
  // A window that already covers the thread's true size never advertises an
  // earlier page (the exact-boundary phantom, sol F5).
  const covered = !cursor && page.rows.length >= page.total;
  return {
    messages: [...page.rows].reverse(),
    earlierCursor: !covered && page.nextKey ? { createdAt: page.nextKey.ts, id: page.nextKey.id } : null,
    total: page.total,
  };
}
