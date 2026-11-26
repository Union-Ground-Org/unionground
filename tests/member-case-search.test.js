// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CASE_SEARCH_LIMIT, CASE_SEARCH_RPC, searchMemberCases } from "../src/features/cases/caseSearchApi.js";
import { MemberApiError } from "../src/lib/memberApi.js";
import { memberOpenableCaseEntries, serverCaseEntries } from "../src/lib/searchIndex.js";

function rpcClient(result, { rejectName = null } = {}) {
  const calls = [];
  const rpc = vi.fn((name, args) => {
    const call = { name, args, signal: null };
    calls.push(call);
    const builder = {
      abortSignal: vi.fn((signal) => {
        call.signal = signal;
        return builder;
      }),
      then(resolve, reject) {
        if (rejectName && name === rejectName) {
          return Promise.resolve({ data: null, error: { message: "search unavailable", code: "08006" } }).then(resolve, reject);
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  });
  return { client: { rpc }, rpc, calls };
}

describe("searchMemberCases", () => {
  it("returns nothing without a client or a query", async () => {
    const { client, rpc } = rpcClient({ data: [{ case_id: "abc" }], error: null });
    await expect(searchMemberCases(null, "overtime")).resolves.toEqual([]);
    await expect(searchMemberCases(client, "   ")).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls the authenticated RPC with the clamped page the palette and Search can show", async () => {
    const row = {
      case_id: "abc",
      reference: "SG-1",
      title: "Overtime",
      articles: "Art. 8",
      step: "Step 1",
      case_type: "Scheduling",
      deadline: "2026-07-24",
      rank: 1,
      headline: "[[Overtime]] distribution",
      headline_source: "articles",
    };
    const { client, rpc, calls } = rpcClient({ data: [row], error: null });
    const signal = new AbortController().signal;
    const entries = await searchMemberCases(client, " overtime ", { signal, formatDeadline: () => "Jul 24" });
    expect(rpc).toHaveBeenCalledWith(CASE_SEARCH_RPC, { p_query: "overtime", p_limit: CASE_SEARCH_LIMIT });
    expect(calls[0].signal).toBe(signal);
    expect(entries).toEqual([expect.objectContaining({
      id: "case:abc",
      title: "SG-1 · Overtime",
      pinned: true,
      focus: { view: "cases", path: "/m/cases?case=abc", caseId: "abc", filter: "all" },
    })]);
    // The inert article and step columns never reach the result card or the
    // local haystack: Union Ground issues carry neither.
    expect(entries[0].snippet).toBe("Overtime distribution");
    expect(`${entries[0].snippet} ${entries[0].meta} ${entries[0].haystack}`).not.toMatch(/Art\. 8|Step 1/i);
  });

  it("wraps a PostgREST failure as a MemberApiError", async () => {
    const { client } = rpcClient({ data: null, error: { message: "search unavailable", code: "08006" } }, { rejectName: CASE_SEARCH_RPC });
    await expect(searchMemberCases(client, "overtime")).rejects.toMatchObject({
      name: "MemberApiError",
      message: "Search cases: search unavailable",
      code: "08006",
    });
    await expect(searchMemberCases(client, "overtime")).rejects.toBeInstanceOf(MemberApiError);
  });

  it("recovers on a later query after a transient failure and keeps the own-case destination boundary", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "temporarily unavailable", code: "08006" } })
      .mockResolvedValueOnce({ data: [
        { case_id: "own-1", reference: "SG-1", title: "Contract overtime", headline: "[[Contract]] overtime" },
        { case_id: "staff-2", reference: "SG-2", title: "Other member's case", headline: "[[Contract]] overtime" },
      ], error: null });
    const client = { rpc };
    await expect(searchMemberCases(client, "contract")).rejects.toMatchObject({ code: "08006" });
    const entries = await searchMemberCases(client, "contract overtime");
    expect(memberOpenableCaseEntries(entries, [{ id: "own-1" }])).toEqual([
      expect.objectContaining({ title: "SG-1 · Contract overtime", focus: { view: "cases", path: "/m/cases?case=own-1", caseId: "own-1", filter: "all" } }),
    ]);
  });
});

// BUG-UG-WEB-MEMBER-SEARCH-LISTS-UNOPENABLE-CASES-20261003: Search and
// the command palette share this filter on the member hat.
describe("memberOpenableCaseEntries", () => {
  const rows = serverCaseEntries([
    { case_id: "own-1", reference: "SG-1", title: "Own", headline: "" },
    { case_id: "caseload-2", reference: "SG-2", title: "Caseload", headline: "" },
  ]);

  it("keeps only server rows for the member's own cases", () => {
    expect(memberOpenableCaseEntries(rows, [{ id: "own-1" }]).map((item) => item.focus.caseId)).toEqual(["own-1"]);
  });

  it("keeps nothing when the member has no cases or the inputs are missing", () => {
    expect(memberOpenableCaseEntries(rows, [])).toEqual([]);
    expect(memberOpenableCaseEntries(rows, undefined)).toEqual([]);
    expect(memberOpenableCaseEntries(null, [{ id: "own-1" }])).toEqual([]);
  });
});
