// @vitest-environment node
// PR4a staff planes: coordinator widening + roster/VP aggregates. These pin
// the security shape of the migration text plus the one client invariant that
// makes the widening safe (loadMemberApp self-scoping).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: staff_can_see_user and the chapter-scoped staff RPCs, which
// 20260723040000_chapter_model_foundation rewrote after the plane migrations
// this file reads.

const coordSql = loadMigrationSql("20260723160000_coordinator_case_plane.sql");
const completenessSql = loadMigrationSql("20260805120000_coordinator_completeness.sql");
const vpSql = loadMigrationSql("20260723161000_staff_roster_vp_overview.sql");
const memberApiSrc = readFileSync(new URL("../src/lib/memberApi.js", import.meta.url), "utf8");
const allMigrations = migrationFiles().map((entry) => entry.sql).join("\n");

describe("coordinator RLS widening", () => {
  it("widens only case data, case records, and member identity to coordinators", () => {
    const policies = [...new Set(
      [...allMigrations.matchAll(/create policy (\w+_select_coordinator) on public\.(\w+)/g)]
        .map(([, policy, table]) => `${table}:${policy}`),
    )].sort();
    expect(policies).toEqual([
      "coordinator_case_audit:coordinator_case_audit_select_coordinator",
      "member_case_contacts:member_case_contacts_select_coordinator",
      "member_case_outcomes:member_case_outcomes_select_coordinator",
      "member_case_updates:member_case_updates_select_coordinator",
      "member_cases:member_cases_select_coordinator",
      "member_profiles:member_profiles_select_coordinator",
    ]);
  });

  it("routes every coordinator policy through the chapter gate with the right owner column", () => {
    expect(coordSql).toContain("on public.member_cases\n  for select to authenticated using (public.staff_can_see_user(user_id, 'coordinator'));");
    expect(coordSql).toContain("on public.member_case_updates\n  for select to authenticated using (public.staff_can_see_user(user_id, 'coordinator'));");
    // Profiles key on id (the profile PK is the member id), not user_id.
    expect(coordSql).toContain("on public.member_profiles\n  for select to authenticated using (public.staff_can_see_user(id, 'coordinator'));");
  });

  it("keeps the self-scoped tables self-scoped — no coordinator policy leaks onto them", () => {
    for (const table of ["member_ballot_votes", "member_survey_responses", "member_action_log", "member_notifications", "member_point_events", "member_workload_logs", "member_forms", "member_guide_threads", "member_guide_messages"]) {
      expect(allMigrations, `${table} must stay self-scoped`).not.toMatch(new RegExp(`create policy \\w*coordinator\\w* on public\\.${table}\\b`));
    }
  });

  it("keeps member_roles service-side-only: no client write grant anywhere", () => {
    expect(allMigrations).not.toMatch(/grant\s+(insert|update|delete)[^;]*on\s+public\.member_roles/i);
    expect(allMigrations).not.toMatch(/grant\s+select,\s*insert[^;]*on\s+public\.member_roles/i);
  });

  it("ships the (status, deadline) index replayably — live apply builds it CONCURRENTLY", () => {
    expect(coordSql).toContain("create index if not exists member_cases_status_deadline_idx on public.member_cases(status, deadline);");
  });
});

describe("aggregate RPC security shape", () => {
  const guards = [
    { sql: coordSql, name: "get_coordinator_kpis", roles: "array['coordinator']" },
    { sql: vpSql, name: "get_staff_roster", roles: "array['admin', 'coordinator', 'advisor', 'vp']" },
    { sql: vpSql, name: "get_vp_overview", roles: "array['vp', 'admin']" },
  ];

  for (const { sql, name, roles } of guards) {
    it(`${name} is a role-gated definer with an empty search_path`, () => {
      const body = fnBody(sql, name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain(`not public.member_has_role(${roles})`);
      expect(body).toContain("errcode = '42501'");
      expect(sql).toContain(`revoke all on function public.${name}() from public, anon;`);
      expect(sql).toContain(`grant execute on function public.${name}() to authenticated;`);
    });
  }

  it("chapter-scopes both KPI aggregates through the caller's role row", () => {
    for (const body of [fnBody(coordSql, "get_coordinator_kpis"), fnBody(vpSql, "get_vp_overview")]) {
      expect(body).toContain("select r.chapter_id into caller_chapter");
      expect(body).toContain("caller_chapter is null or p.chapter_id = caller_chapter");
    }
  });

  it("computes the coordinator KPIs in one materialized pass with a 7-day due window", () => {
    const body = fnBody(coordSql, "get_coordinator_kpis");
    // One scan of the 400k-row join, not three: the tallies read the CTE.
    expect(body).toContain("with base as materialized");
    expect(body.match(/from public\.member_cases c/g)).toHaveLength(1);
    // "Due this week" means 7 days inclusive of today, not 8.
    expect(body).toContain("between current_date and current_date + 6");
    expect(body).not.toContain("current_date + 7");
  });

  it("keeps the roster page and priorities ordering deterministic", () => {
    expect(fnBody(vpSql, "get_staff_roster")).toContain("order by user_id\n      limit 200");
    // Postgres only guarantees jsonb_agg order via the aggregate-level ORDER BY.
    expect(fnBody(vpSql, "get_vp_overview")).toContain("jsonb_agg(x.obj order by x.order_index)");
  });

  it("VP attention items expose reference/title/step/deadline only — never a case body", () => {
    const body = fnBody(vpSql, "get_vp_overview");
    const intoIdx = body.indexOf("into attention");
    const attention = body.slice(body.lastIndexOf("select coalesce", intoIdx), body.indexOf("into upcoming"));
    expect(attention).toContain("'reference', s.reference");
    expect(attention).not.toContain("case_type");
    // member_case_updates (the narrative timeline) is not read at all by the VP overview.
    expect(body).not.toContain("member_case_updates");
  });

  it("adds no CHECK changes — the vp slug already ships in the PR1 chapter migration", () => {
    expect(vpSql).not.toContain("member_roles_role_check");
    expect(allMigrations).toContain("check (role in ('steward', 'coordinator', 'advisor', 'admin', 'vp'))");
  });
});

describe("member surface stays self-scoped under the widening", () => {
  it("loadMemberApp filters member_cases and member_case_updates by the signed-in user", () => {
    // THE load-bearing client fix: without these filters the coordinator
    // policies leak every member's cases into a coordinator's own Cases view.
    expect(memberApiSrc).toContain('client.from("member_cases").select(MEMBER_CASE_COLUMNS).eq("user_id", user.id)');
    expect(memberApiSrc).toContain('client.from("member_case_updates").select(MEMBER_CASE_UPDATE_COLUMNS).eq("user_id", user.id)');
    // The boot read names its columns, so a later search projection on either
    // case table can never ride along in the snapshot.
    expect(memberApiSrc).toMatch(/const MEMBER_CASE_COLUMNS = \[[^\]]+"id", "user_id", "reference"/);
    expect(memberApiSrc).not.toMatch(/MEMBER_CASE_COLUMNS = \[[^\]]+search_document/);
    expect(memberApiSrc).not.toMatch(/MEMBER_CASE_UPDATE_COLUMNS = \[[^\]]+search_document/);
  });

  it("loadCoordinatorDesk resolves names through a bounded primary-key lookup", () => {
    const start = memberApiSrc.indexOf("const COORDINATOR_CASE_PAGE");
    const body = memberApiSrc.slice(start, memberApiSrc.indexOf("export async function loadVpOverview"));
    expect(body).toContain('rpc("get_coordinator_kpis")');
    expect(body).toContain('.in("id", referencedIds)');
  });

  it("loadCoordinatorDesk serves complete data through the invoker RPC pair", () => {
    const start = memberApiSrc.indexOf("const COORDINATOR_CASE_PAGE");
    const body = memberApiSrc.slice(start, memberApiSrc.indexOf("export async function loadVpOverview"));
    // The server owns case pages and per-case histories: the flat capped
    // table fetches — and the truncation flags that disclosed them — are gone.
    expect(body).toContain('rpc("list_coordinator_cases", { p_focus: "all", p_limit: COORDINATOR_CASE_PAGE })');
    expect(body).toContain('rpc("list_case_latest_updates", { p_case_ids: caseIds, p_per_case: COORDINATOR_UPDATES_PER_CASE })');
    expect(body).not.toContain("limit(1000)");
    expect(body).not.toContain("casesTruncated");
    expect(body).not.toContain("updatesTruncated");
  });
});

describe("coordinator completeness RPCs", () => {
  it("list_coordinator_cases is an invoker keyset pager sharing the KPI predicates", () => {
    const body = fnBody(completenessSql, "list_coordinator_cases");
    expect(body).toContain("security invoker");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not public.member_has_role(array['coordinator'])");
    expect(body).toContain("errcode = '42501'");
    // The single definition: the same due window and arbitration predicate
    // get_coordinator_kpis counts, so tiles and drilldowns cannot drift.
    expect(body).toContain("between current_date and current_date + 6");
    expect(body).not.toContain("current_date + 7");
    expect(body).toContain("c.step ~* 'arb' or c.step = 'Step 4'");
    // Keyset over the (deadline nulls last, id) sort with a bounded page.
    expect(body).toContain("order by c.deadline asc nulls last, c.id asc");
    expect(body).toContain("least(greatest(coalesce(p_limit, 200), 1), 200)");
    expect(completenessSql).toContain("revoke all on function public.list_coordinator_cases(text, date, uuid, integer) from public, anon;");
    expect(completenessSql).toContain("grant execute on function public.list_coordinator_cases(text, date, uuid, integer) to authenticated, service_role;");
  });

  it("list_case_latest_updates returns bounded per-case histories with true totals", () => {
    const body = fnBody(completenessSql, "list_case_latest_updates");
    expect(body).toContain("security invoker");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("row_number() over (partition by u.case_id order by u.created_at desc, u.id desc)");
    expect(body).toContain("count(*) over (partition by u.case_id)");
    expect(body).toContain("least(greatest(coalesce(p_per_case, 20), 1), 100)");
    // Bounded fan-in: the id array is capped, not open-ended.
    expect(body).toContain("> 500");
    expect(completenessSql).toContain("revoke all on function public.list_case_latest_updates(uuid[], integer) from public, anon;");
    expect(completenessSql).toContain("grant execute on function public.list_case_latest_updates(uuid[], integer) to authenticated, service_role;");
  });
});

describe("staff plane loaders", () => {
  function builder(result) {
    const b = {
      select: () => b, order: () => b, limit: () => b, range: () => b, in: () => b, eq: () => b,
      then: (resolve) => Promise.resolve(result).then(resolve),
    };
    return b;
  }

  it("loadCoordinatorDesk maps rows, resolves names, and degrades KPI errors to {}", async () => {
    const { loadCoordinatorDesk } = await import("../src/lib/memberApi.js");
    const rpcReads = [];
    const tables = {
      member_profiles: { data: [{ id: "u1", full_name: "Ada Union", initials: "AU" }], error: null },
      member_case_contacts: { data: [{ id: "ct1", case_id: "c1", contact_type: "phone", direction: "outbound", summary: "Called HR", contacted_at: "2026-07-06T12:00:00Z", created_at: "2026-07-06T12:00:00Z" }], error: null },
      member_case_outcomes: { data: [{ case_id: "c1", outcome: "settled", summary: "Back pay restored", recorded_at: "2026-07-07T12:00:00Z", updated_at: "2026-07-07T12:00:00Z" }], error: null },
    };
    const rpcs = {
      list_coordinator_cases: { data: [{ id: "c1", user_id: "u1", reference: "G-1", title: "Mandated overtime", case_type: "Scheduling", articles: "Art. 8.3", step: "Step 1", status: "active", deadline: "2026-07-01", created_at: "", updated_at: "" }], error: null },
      // The wire order is chronological per case, with the true history size
      // riding along on every row.
      list_case_latest_updates: { data: [
        { case_id: "c1", id: "up1", body: "Step 1 filed.", created_at: "2026-07-02T12:00:00Z", total_count: 3 },
        { case_id: "c1", id: "up2", body: "Step 2 scheduled.", created_at: "2026-07-05T12:00:00Z", total_count: 3 },
      ], error: null },
      get_coordinator_kpis: { data: null, error: { message: "kpis down" } },
    };
    const client = {
      from: (table) => builder(tables[table] ?? { data: [], error: null }),
      rpc: async (name) => { rpcReads.push(name); return rpcs[name] ?? { data: [], error: null }; },
    };
    const desk = await loadCoordinatorDesk(client);
    expect(desk.kpis).toEqual({});
    expect(desk.cases[0].memberName).toBe("Ada Union");
    expect(desk.cases[0].overdue).toBe(true);
    expect(desk.cases[0].updates.map((u) => u.body)).toEqual(["Step 1 filed.", "Step 2 scheduled."]);
    expect(desk.cases[0].updates.map((u) => u.createdAtValue)).toEqual(["2026-07-02T12:00:00Z", "2026-07-05T12:00:00Z"]);
    // The per-case total distinguishes a recent slice from a full history.
    expect(desk.cases[0].totalUpdates).toBe(3);
    expect(desk.cases[0].contacts).toEqual([expect.objectContaining({ id: "ct1", type: "phone", summary: "Called HR" })]);
    expect(desk.cases[0].outcome).toEqual(expect.objectContaining({ kind: "settled", summary: "Back pay restored" }));
    // A short first page means the chapter is fully loaded — no cursor.
    expect(desk.nextCursor).toBeNull();
    for (const read of ["list_coordinator_cases", "get_coordinator_kpis", "list_case_latest_updates", "list_vp_case_reviews"]) {
      expect(rpcReads.filter(name => name === read), read).toHaveLength(1);
    }
  });

  it("loadCoordinatorCases forwards focus plus keyset cursor and reports the next one", async () => {
    const { loadCoordinatorCases } = await import("../src/lib/memberApi.js");
    const calls = [];
    const caseRow = (id, deadline) => ({ id, user_id: "u1", reference: id, title: "T", case_type: "", articles: "", step: "Step 1", status: "active", deadline, created_at: "", updated_at: "" });
    const client = {
      from: () => builder({ data: [], error: null }),
      rpc: async (name, args) => {
        calls.push([name, args]);
        if (name === "list_coordinator_cases") return { data: [caseRow("c1", "2026-07-01"), caseRow("c2", "2026-07-02")], error: null };
        return { data: [], error: null };
      },
    };
    const page = await loadCoordinatorCases(client, { focus: "due", cursor: { deadline: "2026-06-30", id: "c0" }, limit: 2 });
    expect(calls[0]).toEqual(["list_coordinator_cases", { p_focus: "due", p_after_deadline: "2026-06-30", p_after_id: "c0", p_limit: 2 }]);
    // A full page hands back the last row's keyset position.
    expect(page.nextCursor).toEqual({ deadline: "2026-07-02", id: "c2" });
    expect(page.cases).toHaveLength(2);
  });

  it("clamps a caller limit above the SQL cap so the cursor contract holds", async () => {
    // SQL clamps p_limit to 200; if the loader asked for more and compared the
    // returned length against the unclamped number, a full 200-row page would
    // look short, drop the cursor, and strand the rest of the chapter.
    const { loadCoordinatorCases } = await import("../src/lib/memberApi.js");
    const calls = [];
    const client = {
      from: () => builder({ data: [], error: null }),
      rpc: async (name, args) => {
        calls.push([name, args]);
        return { data: [], error: null };
      },
    };
    await loadCoordinatorCases(client, { limit: 999 });
    expect(calls[0][1].p_limit).toBe(200);
  });

  // SOL-20260813-07: list_vp_case_reviews authorizes steward/coordinator/
  // advisor/admin/vp, but only the President's plane and the admin trail read
  // it, so the desk that actually works the case could not say it had been
  // reviewed. These pin the mapping and its honest degrade.
  describe("President review attribution on the coordinator desk", () => {
    const reviewedCaseRow = { id: "c1", user_id: "u1", reference: "G-1", title: "Mandated overtime", case_type: "Scheduling", articles: "", step: "Step 1", status: "active", deadline: "2026-07-01", created_at: "", updated_at: "" };

    function reviewClient(reviewsResult) {
      const calls = [];
      const client = {
        from: () => builder({ data: [], error: null }),
        rpc: async (name) => {
          calls.push(name);
          if (name === "list_coordinator_cases") return { data: [reviewedCaseRow, { ...reviewedCaseRow, id: "c2", reference: "G-2" }], error: null };
          if (name === "list_vp_case_reviews") return reviewsResult;
          return { data: [], error: null };
        },
      };
      return { client, calls };
    }

    it("maps a review onto its own case, localizes the date, and leaves unreviewed cases null", async () => {
      const { loadCoordinatorDesk, conversationDateLabel } = await import("../src/lib/memberApi.js");
      const { client, calls } = reviewClient({
        data: [{ caseId: "c1", reviewedAt: "2026-07-23T15:00:00Z", reviewedBy: "vp-1", reviewerName: "Taylor Morgan", caseReference: "G-1", caseTitle: "Mandated overtime" }],
        error: null,
      });
      const desk = await loadCoordinatorDesk(client, "es");
      expect(calls).toContain("list_vp_case_reviews");
      expect(desk.cases[0].review).toEqual({
        reviewerName: "Taylor Morgan",
        reviewedAt: "2026-07-23T15:00:00Z",
        reviewedLabel: conversationDateLabel("2026-07-23T15:00:00Z", "es"),
      });
      // The label really is localized, not the English string in disguise.
      expect(desk.cases[0].review.reviewedLabel).not.toBe(conversationDateLabel("2026-07-23T15:00:00Z", "en"));
      // A chapter-wide review list must not smear one case's review across
      // the whole queue.
      expect(desk.cases[1].review).toBeNull();
    });

    it("degrades a failed review read to null attribution instead of taking down the desk", async () => {
      const { loadCoordinatorDesk } = await import("../src/lib/memberApi.js");
      const { client } = reviewClient({ data: null, error: { message: "reviews down" } });
      const desk = await loadCoordinatorDesk(client);
      expect(desk.cases).toHaveLength(2);
      expect(desk.cases[0].review).toBeNull();
      expect(desk.cases[1].review).toBeNull();
    });

    it("drops a review row that carries no reviewer name or no date — half an attribution is not attribution", async () => {
      const { loadCoordinatorDesk } = await import("../src/lib/memberApi.js");
      const { client } = reviewClient({
        data: [
          { caseId: "c1", reviewedAt: "2026-07-23T15:00:00Z", reviewerName: null },
          { caseId: "c2", reviewedAt: null, reviewerName: "Taylor Morgan" },
        ],
        error: null,
      });
      const desk = await loadCoordinatorDesk(client);
      expect(desk.cases[0].review).toBeNull();
      expect(desk.cases[1].review).toBeNull();
    });

    it("carries the same attribution through the keyset drilldown pages, not just the first desk load", async () => {
      const { loadCoordinatorCases } = await import("../src/lib/memberApi.js");
      const { client } = reviewClient({
        data: [{ caseId: "c2", reviewedAt: "2026-07-23T15:00:00Z", reviewerName: "Taylor Morgan" }],
        error: null,
      });
      const page = await loadCoordinatorCases(client, { focus: "due" });
      expect(page.cases[0].review).toBeNull();
      expect(page.cases[1].review).toMatchObject({ reviewerName: "Taylor Morgan" });
    });

    it("skips the review read entirely when the page has no cases", async () => {
      const { loadCoordinatorDesk } = await import("../src/lib/memberApi.js");
      const calls = [];
      const client = {
        from: () => builder({ data: [], error: null }),
        rpc: async (name) => { calls.push(name); return { data: [], error: null }; },
      };
      const desk = await loadCoordinatorDesk(client);
      expect(desk.cases).toEqual([]);
      expect(calls).not.toContain("list_vp_case_reviews");
    });
  });

  it("loadVpOverview requires the overview and degrades the roster to []", async () => {
    const { loadVpOverview } = await import("../src/lib/memberApi.js");
    const okClient = { rpc: async (name) => (name === "get_vp_overview" ? { data: { memberCount: 3 }, error: null } : { data: null, error: { message: "roster down" } }) };
    const result = await loadVpOverview(okClient);
    expect(result.overview.memberCount).toBe(3);
    expect(result.roster).toEqual([]);
    const badClient = { rpc: async () => ({ data: null, error: { message: "denied" } }) };
    await expect(loadVpOverview(badClient)).rejects.toThrow("Leadership overview: denied");
  });
});
