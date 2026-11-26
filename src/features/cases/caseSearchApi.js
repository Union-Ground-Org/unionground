import { MemberApiError } from "../../lib/memberApi.js";
import { serverCaseEntries } from "../../lib/searchIndex.js";

export const CASE_SEARCH_RPC = "search_member_cases";
// The RPC clamps to 1..50 itself; twenty is what a palette and a search page
// can actually show without paging, and asking for less keeps the ts_headline
// work proportional to what is rendered.
export const CASE_SEARCH_LIMIT = 20;
// The RPC's own ceiling. It ranks the caller's own cases together with the
// caseload and queue they can read as staff, so a member surface that keeps
// only its own cases asks for the most rows the RPC will give before
// filtering; asking for the few it shows would let better-ranked staff rows
// crowd an own case out (BUG-UG-WEB-MEMBER-SEARCH-LISTS-UNOPENABLE-CASES-20261003).
export const CASE_SEARCH_MAX_LIMIT = 50;

// Server-side case search (REQ-...-57-CASE-SEARCH-20260917). The local index in
// src/lib/searchIndex.js can only ever see the member snapshot loadMemberApp
// fetched; this reads the GIN indexes over every case the caller may select —
// their own, a steward's assigned caseload, a coordinator's chapter queue —
// and matches stems rather than substrings. Authorization is the RPC's, not
// this module's: it returns exactly the rows the caller's own RLS would.
// The raw rows, before any display formatting. The hook keeps these so a
// language change can relabel deadlines without asking the server again
// (BUG-UG-CASE-SEARCH-DEADLINE-LANGUAGE-20261020).
export async function fetchMemberCaseRows(client, query, {
  limit = CASE_SEARCH_LIMIT,
  signal = null,
} = {}) {
  const trimmed = String(query ?? "").trim();
  if (!client || !trimmed) return [];

  let request = client.rpc(CASE_SEARCH_RPC, { p_query: trimmed, p_limit: limit });
  if (signal && typeof request.abortSignal === "function") request = request.abortSignal(signal);

  const { data, error } = await request;
  if (error) throw new MemberApiError("Search cases", error);
  return Array.isArray(data) ? data : [];
}

export async function searchMemberCases(client, query, { limit, signal, formatDeadline, t } = {}) {
  const rows = await fetchMemberCaseRows(client, query, { limit, signal });
  return serverCaseEntries(rows, { ...(formatDeadline ? { formatDeadline } : {}), ...(t ? { t } : {}) });
}
