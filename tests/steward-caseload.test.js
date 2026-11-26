// @vitest-environment node
//
// REQ-UNION-BASE-STEWARD-CASELOAD-READ-20260808 (role-map record UB-CASE-05):
// stewards read exactly the cases where they are the named assignee. These
// pins hold the three layers to the same contract:
//
//   * the migration's two policies carry the assignee predicate and the
//     steward role gate, and NOT the chapter-wide staff_can_see_user
//     primitive — the owner decision was assignee scope, deliberately
//     narrower than the coordinator plane;
//   * scripts/db-contract.json carries matching pins (so verify:db enforces
//     the live catalog) and no longer forbids the steward read it used to;
//   * the client loader applies the same predicate on its side, so the
//     steward's OWN member cases (visible through member_cases_select_own)
//     never render as caseload.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStewardDesk } from "../src/lib/memberApi.js";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = stripComments(loadMigrationSql("steward_caseload_read"));
const contract = JSON.parse(readFileSync(join(repoRoot, "scripts/db-contract.json"), "utf8"));
//  (20261102005607) folds the merged member_cases read into one row-typed
// predicate whose whole installed definition the contract pins by bodyMd5.
const chapterCaseReadable = fnBody(loadMigrationSql("20261102005607_"), "private.chapter_case_readable");

describe("steward caseload migration", () => {
  it("grants the member_cases read on the assignee predicate with the steward role gate", () => {
    expect(migration).toMatch(
      /create policy member_cases_select_steward on public\.member_cases\s+for select to authenticated\s+using \(\s*steward_user_id = \(select auth\.uid\(\)\)\s+and public\.member_has_role\(array\['steward'\]\)\s*\);/,
    );
  });

  it("grants the member_case_updates read only through the assigned parent case", () => {
    expect(migration).toMatch(
      /create policy member_case_updates_select_steward on public\.member_case_updates\s+for select to authenticated\s+using \(\s*public\.member_has_role\(array\['steward'\]\)\s+and exists \(\s*select 1 from public\.member_cases c\s+where c\.id = case_id\s+and c\.steward_user_id = \(select auth\.uid\(\)\)\s*\)\s*\);/,
    );
  });

  it("never reaches for the chapter-wide staff_can_see_user primitive", () => {
    expect(migration).not.toContain("staff_can_see_user");
  });

  it("creates exactly the two policies and nothing else", () => {
    expect(migration.match(/create policy/g)).toHaveLength(2);
    expect(migration).not.toMatch(/\b(grant|revoke|alter policy|drop policy|create table|alter table)\b/);
  });
});

// The top-level OR operands of a deparsed policy qual.
function orBranches(qual) {
  const body = qual.slice(1, -1);
  const branches = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "(") depth += 1;
    else if (body[index] === ")") depth -= 1;
    else if (depth === 0 && body.startsWith(" OR ", index)) {
      branches.push(body.slice(start, index));
      start = index + 4;
    }
  }
  return [...branches, body.slice(start)];
}

describe("db-contract pins", () => {
  const byKey = new Map(contract.policies.map((entry) => [`${entry.table}.${entry.name}`, entry]));

  it("pins both steward policies to the EXACT live quals — no needle-satisfying widening can pass", () => {
    // Exact pg_get_expr text captured from prod at apply time (
    // finding: qualContains needles would tolerate an appended OR branch).
    // verify:db compares these with plain string equality against the live
    // catalog, so any ALTER POLICY — widening or otherwise — turns CI red.
    // Since 20261028210000 each steward read is the second OR branch of its
    // table's merged _select policy, whose whole qual is pinned exactly.
    // Since  the member_cases policy is exactly private.chapter_case_readable,
    // and the steward branch is the same assignment-and-role test inside it.
    const casesPolicy = byKey.get("member_cases.member_cases_select");
    expect(casesPolicy).toBeDefined();
    expect(casesPolicy.cmd).toBe("r");
    expect(casesPolicy.qual).toBe("private.chapter_case_readable(member_cases.*)");
    expect(contract.functions.find((entry) => entry.sig === "private.chapter_case_readable(p_case member_cases)")?.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(chapterCaseReadable).toContain("or (p_case.steward_user_id=(select auth.uid()) and public.member_has_role(array['steward']))");

    const updatesPolicy = byKey.get("member_case_updates.member_case_updates_select");
    expect(updatesPolicy).toBeDefined();
    expect(updatesPolicy.cmd).toBe("r");
    // Since 20261106226000  the update read is one branch: the parent
    // case readable under member_cases' policies. The steward branch it held
    // already implied it (the assigned-steward test lives in
    // chapter_case_readable, pinned above).
    expect(orBranches(updatesPolicy.qual)).toHaveLength(1);
    expect(updatesPolicy.qual).toBe("(EXISTS ( SELECT 1\n   FROM member_cases c\n  WHERE ((c.id = member_case_updates.case_id) AND private.chapter_case_readable(c.*))))");
    // The chapter-wide primitive must not appear per update row.
    expect(updatesPolicy.qual).not.toContain("staff_can_see_user");
  });

  it("no longer forbids the steward read of the two case tables", () => {
    const wouldBlock = (table, name) => contract.policiesForbidden.some(
      (entry) => entry.table === table && new RegExp(entry.namePattern).test(name),
    );
    expect(wouldBlock("member_cases", "member_cases_select_steward")).toBe(false);
    expect(wouldBlock("member_case_updates", "member_case_updates_select_steward")).toBe(false);
  });

  it("keeps the coordinator pins bounded — restricted cases require assignment, an elevated role, or an explicit grant", () => {
    // The coordinator reads are the third OR branch of the merged policies
    // since 20261028210000.
    // Since  the member_cases read gates every branch, the coordinator's
    // included, on the same row-typed restriction predicate.
    expect(chapterCaseReadable).toContain("or public.staff_can_see_user(p_case.user_id,'coordinator')");
    // 20260925995000: the restriction branch is the single row-typed predicate
    // (not restricted, assignment, an elevated role, or an explicit grant live
    // in private.member_case_row_visible, pinned by its own contract entry).
    expect(chapterCaseReadable).toContain("select private.mfa_satisfied() and private.member_case_row_visible(p_case)");
    expect(chapterCaseReadable).not.toContain("casework_access_grants");
    const rowVisible = contract.functions.find((entry) => entry.sig === "private.member_case_row_visible(p_case member_cases)");
    expect(rowVisible?.bodyContains).toEqual(expect.arrayContaining([
      "not p_case.is_restricted",
      "p_case.coordinator_user_id = (select auth.uid())",
      "private.has_organization_role(p_case.organization_id, array['advisor','admin','vp'])",
      "private.casework_actor_has_active_grant(p_case.id)",
    ]));
    // 20260917103000 put the child rows behind the same gate as the case row:
    // the coordinator's scope conjunct survives, and the parent must also be
    // visible under the member_cases policies. member_case_updates no longer
    // has a coordinator branch since 20261106226000; its single
    // readable-parent branch is pinned above.
    for (const table of ["member_case_contacts", "member_case_outcomes", "coordinator_case_audit"]) {
      const coordinator = `(staff_can_see_user(user_id, 'coordinator'::text) AND (EXISTS ( SELECT 1\n   FROM member_cases c\n  WHERE (c.id = ${table}.case_id))))`;
      // Article-bearing updates also admit the existing scoped staff editor;
      // the original coordinator branch and its parent gate remain exact.
      const expected = table === "coordinator_case_audit"
        ? `(${coordinator} OR ((action = 'case_updated'::text) AND (before_value ? 'articles'::text) AND (after_value ? 'articles'::text) AND ((before_value -> 'articles'::text) IS DISTINCT FROM (after_value -> 'articles'::text)) AND (NOT ((before_value - 'articles'::text) IS DISTINCT FROM (after_value - 'articles'::text))) AND private.casework_staff_can_access(case_id)))`
        : coordinator;
      // Since 20261106216000  the outcome read is one merged policy:
      // the case owner's branch first, then this coordinator branch verbatim.
      if (table === "member_case_outcomes") {
        const branches = orBranches(byKey.get("member_case_outcomes.member_case_outcomes_select").qual);
        expect(branches, table).toEqual([
          "((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1\n   FROM member_cases c\n  WHERE ((c.id = member_case_outcomes.case_id) AND (c.user_id = ( SELECT auth.uid() AS uid))))))",
          expected,
        ]);
        expect(byKey.has("member_case_outcomes.member_case_outcomes_select_coordinator"), table).toBe(false);
        continue;
      }
      expect(byKey.get(`${table}.${table}_select_coordinator`)?.qual, table).toBe(expected);
    }
  });
});

// Behavioral loader coverage ( finding: string-presence pins prove
// nothing about the live query chain). A recording fake captures every builder
// call per table, so these assert the ACTUAL filters, ordering, caps, and the
// three honest availability states.
function recordingChain(result, log) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return (...args) => {
        log.push([prop, args]);
        return proxy;
      };
    },
  });
  return proxy;
}

function deskClient({ uid = "steward-1", tables = {}, rpcs = {}, logs = {}, rpcCalls = [] } = {}) {
  return {
    auth: { getSession: async () => ({ data: { session: uid ? { user: { id: uid } } : null } }) },
    from: (table) => {
      logs[table] = logs[table] || [];
      // A table value may be an array of per-call results consumed FIFO —
      // member_cases is queried twice (active window, resolved window).
      const canned = tables[table];
      const result = Array.isArray(canned) ? (canned.length > 1 ? canned.shift() : canned[0]) : canned;
      return recordingChain(result ?? { data: [], error: null }, logs[table]);
    },
    rpc: (name, args) => {
      rpcCalls.push([name, args]);
      return Promise.resolve(rpcs[name] ?? { data: [], error: null });
    },
  };
}

const assignedCase = {
  id: "case-1", user_id: "member-1", reference: "GRV-1", title: "T", case_type: "Grievance",
  articles: "", step: "Step 1", status: "active", deadline: "2026-08-15",
  updated_at: "2026-08-05T12:00:00Z", assigned_at: "2026-08-01T09:00:00Z", coordinator_name: null,
};
const profileRow = { data: [{ id: "member-1", full_name: "Renata Cole", initials: "RC" }], error: null };

const resolvedCase = { ...assignedCase, id: "case-2", status: "resolved", deadline: null };

describe("loadStewardDesk caseload behavior", () => {
  it("scopes both windows to the assignee, excludes self-owned cases, and orders each window for its cap", async () => {
    const logs = {};
    const desk = await loadStewardDesk(deskClient({
      logs,
      tables: {
        member_cases: [{ data: [assignedCase], error: null }, { data: [resolvedCase], error: null }],
        member_profiles: profileRow,
      },
    }));
    const calls = logs.member_cases;
    // Both windows carry the assignee scope and the self-exclusion.
    expect(calls.filter((c) => c[0] === "eq" && c[1][0] === "steward_user_id")).toHaveLength(2);
    expect(calls.filter((c) => c[0] === "neq" && c[1][0] === "user_id")).toHaveLength(2);
    // Active window: soonest dated deadline first, then recency; fetches one
    // past the 200 cap so overflow is PROVEN, never inferred.
    expect(calls).toContainEqual(["eq", ["status", "active"]]);
    expect(calls).toContainEqual(["order", ["deadline", { ascending: true, nullsFirst: false }]]);
    expect(calls).toContainEqual(["limit", [201]]);
    // Resolved window: recency alone, one past the 50 cap — each window's
    // server order matches the queue's display order, so a cap sheds only
    // the oldest resolved tail.
    expect(calls).toContainEqual(["eq", ["status", "resolved"]]);
    expect(calls).toContainEqual(["limit", [51]]);
    expect(desk.caseloadUnavailable).toBe(false);
    expect(desk.caseloadTruncated).toBe(false);
    expect(desk.caseload.map((c) => c.id)).toEqual(["case-1", "case-2"]);
    expect(desk.caseload.map((c) => c.subjectUserId)).toEqual([assignedCase.user_id, resolvedCase.user_id]);
    expect(desk.caseload[0].memberName).toBe("Renata Cole");
  });

  it("treats a missing session as unavailable — never as an empty caseload — and issues no query", async () => {
    const logs = {};
    const desk = await loadStewardDesk(deskClient({ uid: null, logs }));
    expect(desk.caseloadUnavailable).toBe(true);
    expect(desk.caseload).toEqual([]);
    expect(logs.member_cases ?? []).toEqual([]);
  });

  it("treats a failed window read as unavailable", async () => {
    const desk = await loadStewardDesk(deskClient({
      tables: {
        member_cases: [{ data: null, error: { message: "boom" } }, { data: [resolvedCase], error: null }],
        member_profiles: profileRow,
      },
    }));
    expect(desk.caseloadUnavailable).toBe(true);
    expect(desk.caseload).toEqual([]);
  });

  it("discloses truncation only on PROVEN overflow and never renders the overflow row", async () => {
    // Exactly 200 active rows (no 201st): a full-but-complete list, NOT a
    // truncation claim.
    const exactly200 = Array.from({ length: 200 }, (_, i) => ({ ...assignedCase, id: `case-a${i}` }));
    const fullDesk = await loadStewardDesk(deskClient({
      tables: {
        member_cases: [{ data: exactly200, error: null }, { data: [], error: null }],
        member_profiles: profileRow,
      },
    }));
    expect(fullDesk.caseloadTruncated).toBe(false);
    expect(fullDesk.caseload).toHaveLength(200);

    // 201 rows back = overflow proven; the 201st is sliced off and the
    // disclosure carries the REAL loaded counts.
    const overflow = Array.from({ length: 201 }, (_, i) => ({ ...assignedCase, id: `case-a${i}` }));
    const desk = await loadStewardDesk(deskClient({
      tables: {
        member_cases: [{ data: overflow, error: null }, { data: [resolvedCase], error: null }],
        member_profiles: profileRow,
      },
    }));
    expect(desk.caseloadTruncated).toBe(true);
    expect(desk.caseload).toHaveLength(201);
    expect(desk.caseloadWindow).toEqual({ active: 200, resolved: 1 });
  });

  it("batches the timeline RPC under PostgREST's 1,000-row response cap", async () => {
    const rpcCalls = [];
    const manyCases = Array.from({ length: 45 }, (_, i) => ({ ...assignedCase, id: `case-${i}` }));
    await loadStewardDesk(deskClient({
      rpcCalls,
      tables: {
        member_cases: [{ data: manyCases, error: null }, { data: [], error: null }],
        member_profiles: profileRow,
      },
    }));
    const batches = rpcCalls.filter(([name]) => name === "list_case_latest_updates");
    // 45 cases → 40 + 5: no single call can exceed 40 × 20 = 800 rows.
    expect(batches).toHaveLength(2);
    expect(batches[0][1].p_case_ids).toHaveLength(40);
    expect(batches[1][1].p_case_ids).toHaveLength(5);
  });

  it("loads timelines through the per-case RPC and carries each case's true total", async () => {
    const rpcCalls = [];
    const desk = await loadStewardDesk(deskClient({
      rpcCalls,
      tables: {
        member_cases: [{ data: [assignedCase], error: null }, { data: [], error: null }],
        member_profiles: profileRow,
      },
      rpcs: {
        list_case_latest_updates: {
          data: [
            { case_id: "case-1", id: "u-1", body: "first", created_at: "2026-08-01T10:00:00Z", total_count: 25 },
            { case_id: "case-1", id: "u-2", body: "second", created_at: "2026-08-05T10:00:00Z", total_count: 25 },
          ],
          error: null,
        },
      },
    }));
    expect(rpcCalls).toContainEqual(["list_case_latest_updates", { p_case_ids: ["case-1"], p_per_case: 20 }]);
    expect(desk.caseload[0].updates.map((u) => u.body)).toEqual(["first", "second"]);
    // 25 total vs 2 shown: the dialog can say exactly how much is omitted,
    // and a case with zero rows genuinely has zero updates.
    expect(desk.caseload[0].updatesTotal).toBe(25);
    expect(desk.caseUpdatesUnavailable).toBe(false);
  });

  it("flags a failed timeline read instead of claiming 'no updates yet'", async () => {
    const desk = await loadStewardDesk(deskClient({
      tables: {
        member_cases: [{ data: [assignedCase], error: null }, { data: [], error: null }],
        member_profiles: profileRow,
      },
      rpcs: { list_case_latest_updates: { data: null, error: { message: "boom" } } },
    }));
    expect(desk.caseUpdatesUnavailable).toBe(true);
    expect(desk.caseload[0].updates).toEqual([]);
  });

  // SOL-20260813-07: list_vp_case_reviews has always authorized stewards, but
  // no steward surface read it, so the desk that works the case could not say
  // the President had reviewed it.
  it("attributes the President's review to its own case and leaves the rest null", async () => {
    const rpcCalls = [];
    const desk = await loadStewardDesk(deskClient({
      rpcCalls,
      tables: {
        member_cases: [{ data: [assignedCase], error: null }, { data: [resolvedCase], error: null }],
        member_profiles: profileRow,
      },
      rpcs: {
        list_vp_case_reviews: {
          data: [{ caseId: "case-1", reviewedAt: "2026-08-06T15:00:00Z", reviewedBy: "vp-1", reviewerName: "Taylor Morgan" }],
          error: null,
        },
      },
    }));
    expect(rpcCalls.map(([name]) => name)).toContain("list_vp_case_reviews");
    // Raw timestamp: the dialog formats its own dates, so the loader must not
    // pre-label it into a language the view never chose.
    expect(desk.caseload[0].review).toEqual({ reviewerName: "Taylor Morgan", reviewedAt: "2026-08-06T15:00:00Z" });
    expect(desk.caseload[1].review).toBeNull();
  });

  it("degrades a failed review read to null attribution without touching the caseload", async () => {
    const desk = await loadStewardDesk(deskClient({
      tables: {
        member_cases: [{ data: [assignedCase], error: null }, { data: [], error: null }],
        member_profiles: profileRow,
      },
      rpcs: { list_vp_case_reviews: { data: null, error: { message: "reviews down" } } },
    }));
    expect(desk.caseloadUnavailable).toBe(false);
    expect(desk.caseload).toHaveLength(1);
    expect(desk.caseload[0].review).toBeNull();
  });
});
