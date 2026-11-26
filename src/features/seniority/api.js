// REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: the only
// doors to the chapter seniority list and bids
// (supabase/migrations/20261030224501_chapter_seniority_and_bids.sql). Each
// call names its RPC literally so the read-RPC drift guard can resolve it. The
// server applies the rule: a chapter's stewards and coordinators see the whole
// list; a member sees and questions only their own entry.

function ready(client) {
  if (!client?.rpc) throw new Error("seniority is unavailable");
  return client;
}

async function unwrap(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

// "Name,Email,Seniority date,Classification,Tie-break note" or the same
// columns in any order, with a header row. Quoted fields may hold commas.
export function parseSeniorityFile(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const split = (line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted && char === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
      else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  };
  // Accents fold to plain letters, so "Fecha de antigüedad" matches too.
  const header = split(lines[0]).map((name) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, ""));
  const column = (...names) => header.findIndex((name) => names.includes(name));
  const email = column("email", "emailaddress", "correo", "correoelectronico");
  const date = column("senioritydate", "date", "fechadeantiguedad", "fecha", "antiguedad");
  const classification = column("classification", "clasificacion");
  const tieBreak = column("tiebreaknote", "tiebreak", "desempate", "notadedesempate");
  if (email < 0 || date < 0) return [];
  // Every row comes back; the import refuses a file over 500 rows rather than
  // cutting it short.
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return {
      email: cells[email] ?? "",
      seniorityDate: cells[date] ?? "",
      classification: classification >= 0 ? cells[classification] ?? "" : "",
      tieBreakNote: tieBreak >= 0 ? cells[tieBreak] ?? "" : "",
    };
  });
}

export function createSeniorityApi(client) {
  return {
    list: async (chapterId, cursor = null, limit = 50) => unwrap(ready(client).rpc("list_chapter_seniority", {
      p_chapter_id: chapterId, p_after_date: cursor?.afterDate ?? null, p_after_id: cursor?.afterId ?? null, p_limit: limit,
    })),
    searchMembers: async (chapterId, query) => unwrap(ready(client).rpc("search_chapter_seniority_members", { p_chapter_id: chapterId, p_query: query ?? "" })),
    save: async (chapterId, entry) => unwrap(ready(client).rpc("save_chapter_seniority_entry", {
      p_chapter_id: chapterId, p_user_id: entry.userId, p_seniority_date: entry.seniorityDate,
      p_classification: entry.classification || null, p_tie_break_note: entry.tieBreakNote || null,
    })),
    remove: async (entryId) => unwrap(ready(client).rpc("delete_chapter_seniority_entry", { p_entry_id: entryId })),
    importRows: async (chapterId, rows, apply) => unwrap(ready(client).rpc("import_chapter_seniority", { p_chapter_id: chapterId, p_rows: rows, p_apply: Boolean(apply) })),
    answer: async (entryId, answer) => unwrap(ready(client).rpc("answer_chapter_seniority_question", { p_entry_id: entryId, p_answer: answer })),
    deadlines: async (chapterId) => unwrap(ready(client).rpc("list_chapter_bid_deadlines", { p_chapter_id: chapterId })),
    listBids: async (chapterId, offset = 0) => unwrap(ready(client).rpc("list_chapter_bid_windows", { p_chapter_id: chapterId, p_limit: 20, p_offset: offset })),
    // BUG-UG-BID-RECORDS-STALE-AWARD-AND-500-CAP-20261102: one window's
    // bids past the first 500 that listBids carries, in the same order.
    bidPage: async (windowId, offset, limit = 100) => unwrap(ready(client).rpc("list_chapter_bid_window_bids", { p_window_id: windowId, p_offset: offset, p_limit: limit })),
    saveWindow: async (chapterId, window) => unwrap(ready(client).rpc("save_chapter_bid_window", {
      p_id: window.id || null, p_chapter_id: chapterId, p_subject: window.subject,
      p_opens_at: window.opensAt, p_closes_at: window.closesAt, p_status: window.status || "open",
    })),
    recordBid: async (windowId, userId, choice) => unwrap(ready(client).rpc("record_chapter_bid", { p_window_id: windowId, p_user_id: userId, p_choice: choice })),
    award: async (bidId, award) => unwrap(ready(client).rpc("award_chapter_bid", { p_bid_id: bidId, p_award: award || null })),
    mine: async () => unwrap(ready(client).rpc("get_my_seniority", {})),
    // The chapters of the staff member's organization, for staff whose own
    // chapter is not the one they manage. Listing a chapter grants nothing:
    // every seniority and bid routine re-checks seniority_staff_can_manage.
    chapters: async (organizationId) => unwrap(ready(client).from("chapters").select("id,name")
      .eq("organization_id", organizationId).order("order_index").order("name")),
    question: async (entryId, note) => unwrap(ready(client).rpc("question_my_seniority_entry", { p_entry_id: entryId, p_note: note })),
  };
}

export const SENIORITY_IMPORT_MAX_ROWS = 500;

// One page's bid change reaches every other view of the same chapter's bids
// (the deadlines beside the caseload, the bids panel).
export const BIDS_CHANGED_EVENT = "seniority:bids-changed";

export function notifyBidsChanged(chapterId) {
  globalThis.dispatchEvent?.(new CustomEvent(BIDS_CHANGED_EVENT, { detail: { chapterId } }));
}

// Whether a bid can be recorded now: open by status and by the clock, the
// same rule record_chapter_bid applies.
export function bidWindowAcceptsBids(window, now = Date.now()) {
  const opens = Date.parse(window?.opensAt);
  const closes = Date.parse(window?.closesAt);
  return window?.status === "open" && Number.isFinite(opens) && Number.isFinite(closes) && now >= opens && now < closes;
}

// Open bid windows closing within `days`, soonest first: the bid deadlines the
// steward desk lists beside the steward's other dated work.
export function upcomingBidDeadlines(windows, now = Date.now(), days = 30) {
  const horizon = now + days * 86_400_000;
  return (Array.isArray(windows) ? windows : [])
    .filter((window) => window?.status === "open")
    .map((window) => ({ ...window, closesAtMs: Date.parse(window.closesAt) }))
    .filter((window) => Number.isFinite(window.closesAtMs) && window.closesAtMs >= now && window.closesAtMs <= horizon)
    .sort((a, b) => a.closesAtMs - b.closesAtMs);
}
