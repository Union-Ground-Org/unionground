// @vitest-environment node
// Design-tiles data layer: actions-YTD summary extension, case assignees,
// steward badge counts, and the k-floored chapter standing. These pin the
// security and PRIVACY shape of the four draft migrations.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THESE MIGRATIONS
// SAY, not what the database ENDS UP WITH. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db` after apply.

const ytdSql = loadMigrationSql("20260728170000_rewards_summary_actions_ytd.sql");
const assignSql = loadMigrationSql("20260728170500_member_case_assignees.sql");
const badgeSql = loadMigrationSql("20260728171000_steward_badge_counts_rpc.sql");
const standingSql = loadMigrationSql("20260728171500_chapter_standing_rpc.sql");
const allMigrations = migrationFiles().map((entry) => entry.sql).join("\n");

describe("actions YTD — the 2026-07-28 draft text (rewards summary, ninth generation)", () => {
  const body = fnBody(ytdSql, "get_member_rewards_summary");

  it("adds the count and key without touching any schema", () => {
    expect(ytdSql).not.toMatch(/create table|alter table|create index/i);
    expect(body).toContain("'actionsYtd', coalesce(ytd, 0)");
  });

  it("counts the PAID ledger, not the self-reported one", () => {
    // member_point_events is trigger-only; member_action_log grants INSERT to
    // authenticated. The YTD tile must be unforgeable, so the new aggregate
    // reads point events. (The pre-existing streak CTE still reads the action
    // log — that is the eighth generation carried byte-equivalent.)
    const ytdBlock = body.slice(body.indexOf("year_start :="));
    expect(ytdBlock).toContain("from public.member_point_events");
    expect(ytdBlock).not.toContain("from public.member_action_log");
  });

  it("keeps the boundary index-friendly: a timestamptz bound, not an expression on the column", () => {
    // Scoped to the NEW block: the carried eighth-generation streak CTE
    // legitimately truncates occurred_at per-week over the caller's own rows.
    const ytdBlock = body.slice(body.indexOf("year_start :="));
    expect(ytdBlock).toContain("occurred_at >= year_start");
    expect(ytdBlock).not.toMatch(/date_trunc\([^)]*occurred_at/);
  });
});

// The block above pins the DRAFT file only. get_member_rewards_summary is
// redefined by later migrations (20260812160000, 20260813204500, ...), so the
// body that actually ships is the one in the LAST migration declaring it —
// and that body can change ledger sources without a draft-text pin noticing.
// This block resolves the live definition in apply order and pins it there.
const REWARDS_SUMMARY_DECLARATION = /create\s+(?:or\s+replace\s+)?function\s+public\.get_member_rewards_summary\s*\(/i;

function liveRewardsSummary() {
  // migrationFiles() is sorted by filename, which is the order Postgres
  // applies them in, so the last declaring entry wins.
  const entry = [...migrationFiles()].reverse().find((file) => REWARDS_SUMMARY_DECLARATION.test(stripComments(file.sql)));
  if (!entry) throw new Error("no migration declares public.get_member_rewards_summary");
  return { name: entry.name, body: stripComments(fnBody(entry.sql, "public.get_member_rewards_summary")) };
}

// Union Ground has no points economy: its safe-recognition migration
// retires the ledger summary. The live replacement preserves those zero fields
// and adds only the caller’s own referral count.
describe("actions YTD — the live definition", () => {
  const live = liveRewardsSummary();

  it("evaluates the last migration that defines the function, not the draft", () => {
    const names = migrationNames();
    const draft = "20260728170000_rewards_summary_actions_ytd.sql";
    expect(names).toContain(live.name);
    expect(names.indexOf(live.name)).toBeGreaterThan(names.indexOf(draft));
    expect(live.name).toBe("20261111184100_member_referral_attribution.sql");
    expect(live.body).toContain("'actionsYtd', 0");
    expect(live.body).toContain("'retired', true");
    expect(live.body).not.toContain("'actionsYtd', coalesce(ytd, 0)");
  });

  it("reads no ledger, paid or self-reported, and reports no points", () => {
    expect(live.body).not.toContain("public.member_point_events");
    expect(live.body).not.toContain("public.member_action_log");
    for (const key of ["totalPoints", "weekStreak", "actionsYtd"]) {
      expect(live.body).toContain(`'${key}', 0`);
    }
    expect(live.body).toContain("security definer");
    expect(live.body).toContain("from private.member_referrals r");
    expect(live.body).toContain("where r.referrer_user_id = (select auth.uid())");
    expect(live.body).not.toMatch(/select\s+(?:r\.\*|r\.referred_user_id)/i);
    expect(live.body).toContain("set search_path = ''");
    expect(live.body).toContain("where (select auth.uid()) is not null");
  });
});

describe("case assignees", () => {
  const body = fnBody(assignSql, "assign_member_case");

  it("clears assignments when a staff account is deleted, never the case", () => {
    expect(assignSql).toContain("steward_user_id uuid references auth.users(id) on delete set null");
    expect(assignSql).toContain("coordinator_user_id uuid references auth.users(id) on delete set null");
  });

  it("grants members NOTHING on the assignment columns", () => {
    // member_cases stays the sole-writer table 20260725120000 made it: no
    // migration anywhere may grant a client write on the assignee columns.
    expect(allMigrations).not.toMatch(/grant[^;]*\b(steward_user_id|coordinator_user_id|steward_name|coordinator_name|assigned_at)\b[^;]*on\s+public\.member_cases/i);
  });

  it("is a coordinator-gated definer scoped by the same primitive as the read policy", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not public.member_has_role(array['coordinator', 'admin'])");
    expect(body).toContain("public.staff_can_see_user(case_owner, 'coordinator')");
    expect(body).toContain("errcode = '42501'");
    expect(assignSql).toContain("revoke all on function public.assign_member_case(uuid, uuid, uuid) from public, anon;");
    expect(assignSql).toContain("grant execute on function public.assign_member_case(uuid, uuid, uuid) to authenticated;");
  });

  it("keeps assignment coordinator-gated; the steward read stays assignee-scoped", () => {
    // Stewards read their ASSIGNED
    // cases through member_cases_select_steward — that one policy, pinned to
    // the assignee predicate in tests/steward-caseload.test.js, is the only
    // steward policy allowed on member_cases. The assign gate itself must
    // still not include the steward role: a steward can BE assigned, only a
    // coordinator or admin assigns.
    expect(body).not.toContain("array['steward'");
    const stewardCasePolicies = [...allMigrations.matchAll(/create policy (\w*steward\w*) on public\.member_cases\b/g)].map((m) => m[1]);
    expect(stewardCasePolicies).toEqual(["member_cases_select_steward"]);
  });

  it("stamps assignee display names server-side and validates the roles", () => {
    expect(body).toContain("role = 'steward'");
    expect(body).toContain("role = 'coordinator'");
    expect(body).toContain("select full_name into steward_label");
    expect(body).toContain("select full_name into coordinator_label");
  });
});

describe("steward badge counts", () => {
  const body = fnBody(badgeSql, "get_steward_badge_counts");

  it("is a steward-gated definer with an empty search_path", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not public.member_has_role(array['steward'])");
    expect(badgeSql).toContain("revoke all on function public.get_steward_badge_counts() from public, anon;");
    expect(badgeSql).toContain("grant execute on function public.get_steward_badge_counts() to authenticated;");
  });

  it("chapter-scopes both counts through the caller's role row", () => {
    expect(body).toContain("select r.chapter_id into scope_chapter");
    const scopeGuards = body.match(/scope_chapter is null or p\.chapter_id = scope_chapter/g);
    expect(scopeGuards).toHaveLength(2);
  });

  it("returns counts only — no rows, no member ids", () => {
    expect(body).not.toMatch(/returns\s+(setof|table)/i);
    expect(body).toContain("'openRequests'");
    expect(body).toContain("'formsInbox'");
  });
});

describe("chapter standing — the privacy pins", () => {
  const body = fnBody(standingSql, "get_chapter_standing");

  it("is an MFA-gated definer with an empty search_path", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("private.mfa_satisfied()");
    expect(standingSql).toContain("revoke all on function public.get_chapter_standing() from public, anon;");
    expect(standingSql).toContain("grant execute on function public.get_chapter_standing() to authenticated;");
  });

  it("holds the K=25 cohort floor with no fallback cohort", () => {
    expect(body).toContain("k constant integer := 25");
    expect(body).toContain("if cohort < k then");
    // The under-floor return says only enoughData:false — it must not carry
    // a band, a cohort, or any other field computed from neighbours.
    const underFloor = body.slice(body.indexOf("if cohort < k then"), body.indexOf("end if;", body.indexOf("if cohort < k then")));
    expect(underFloor).toContain("'enoughData', false");
    expect(underFloor).not.toContain("standingBand");
    expect(underFloor).not.toContain("cohortBand");
  });

  it("publishes bands, never ordinals, totals, or the denominator", () => {
    expect(body).toContain("'standingBand'");
    expect(body).toContain("'cohortBand'");
    expect(body).not.toMatch(/'rank\w*'/i);
    expect(body).not.toContain("'cohort',");
    expect(body).not.toContain("'myTotal'");
    expect(body).not.toContain("'totalPoints'");
  });

  it("freezes the window to the last complete quarter in the org timezone", () => {
    expect(body).toContain("date_trunc('quarter', now() at time zone 'America/New_York')");
    expect(body).toContain("- interval '3 months'");
    expect(body).toContain("e.occurred_at < q_end");
  });
});
