// @vitest-environment node
// REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030: the member-visible
// union statistics on a live database. Any active member of a union
// organization reads wins and actions by month, grievance outcomes and the
// chapter table of their own organization; each breakdown is withheld whole
// unless every non-zero cell counts at least the anonymity floor of distinct
// people; a small chapter's member count is withheld; nothing from another
// organization is counted, nor any client-written action-log row; signed-out, anon and two-step-short callers are
// refused, and a member of no organization gets {"available": false}.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261031031423_alt_member_pages_server_data.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const code = stripComments(migration);

describe("member union statistics migration (static)", () => {
  it("is one transaction adding one read-only definer function, granted to signed-in users only", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(code.match(/create (or replace )?function [\w.]+/g)).toEqual(["create or replace function public.get_member_union_statistics"]);
    expect(code).not.toMatch(/\b(insert\s+into|update\s+(public|private)\.|delete\s+from|create\s+table|alter\s+table|drop\s+)/i);
    expect(code).toMatch(/returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path to ''/);
    const body = code.slice(code.indexOf("begin\n  perform"));
    expect(body.startsWith("begin\n  perform private.lock_case_graph_read();\n  if caller is null or not private.mfa_satisfied() then\n    raise exception 'authentication required' using errcode = '42501';\n  end if;\n  perform private.member_pin_require_full_session();\n  if private.quarterly_survey_gate_locks_caller() then\n    return pg_catalog.jsonb_build_object('available', false, 'locked', true, 'reason', 'quarterly_survey_gate');\n  end if;")).toBe(true);
    expect(code).toContain("greatest(coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25), 10)");
    expect(code).toContain("revoke all on function public.get_member_union_statistics()\n  from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.get_member_union_statistics()\n  to authenticated;");
  });
});

const runLive = Boolean(process.env.SUPABASE_DB_URL);

function easternMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

// BUG-UG-UNION-STATISTICS-REOPENED-OUTCOMES-AND-OWN-RECORD-COPY-20261102 (#6777):
// the replacement counts wins and outcomes of currently resolved cases only.
const REOPENED_MIGRATION = "supabase/migrations/20261102180500_union_statistics_resolved_outcomes_only.sql";
const reopenedMigration = readFileSync(new URL(`../${REOPENED_MIGRATION}`, import.meta.url), "utf8");

describe("member union statistics reopened-case repair (static)", () => {
  it("replaces only the one function and filters both outcome reads to resolved cases", () => {
    const repair = stripComments(reopenedMigration);
    expect(reopenedMigration).toMatch(/\nbegin;\nset local search_path = pg_catalog;\n/);
    expect(reopenedMigration.trimEnd()).toMatch(/\ncommit;$/);
    expect(repair.match(/create (or replace )?function [\w.]+/g)).toEqual(["create or replace function public.get_member_union_statistics"]);
    expect(repair).not.toMatch(/\b(insert\s+into|update\s+(public|private)\.|delete\s+from|create\s+table|alter\s+table|drop\s+)/i);
    expect(repair.match(/join public\.member_cases c on c\.id = o\.case_id\n\s+where c\.organization_id = org\n\s+and c\.status = 'resolved'/g)).toHaveLength(2);
    // Everything else is the merged function, unchanged.
    const original = code.slice(code.indexOf("create or replace function public.get_member_union_statistics"), code.lastIndexOf("comment on function"));
    const replaced = repair.slice(repair.indexOf("create or replace function public.get_member_union_statistics"), repair.lastIndexOf("comment on function"));
    expect(replaced.replaceAll("      and c.status = 'resolved'\n", "")).toBe(original);
  });
});

describe.skipIf(!runLive)("member union statistics live database behavior", () => {
  let db;
  let ids;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "member-union-statistics-proof" });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  // Fixture rows skip the tables' write triggers (points awards, case
  // binding); a failure surfaces its own error.
  async function fixture(sql, values = []) {
    await db.query("savepoint union_stats_fixture");
    await db.query("set local session_replication_role = replica");
    try {
      await db.query(sql, values);
    } catch (error) {
      await db.query("rollback to savepoint union_stats_fixture");
      throw error;
    } finally {
      await db.query("set local session_replication_role = origin");
    }
    await db.query("release savepoint union_stats_fixture");
  }

  async function user(label, org = null, chapter = null) {
    const id = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${label}-${id}@example.invalid`]);
    if (org) {
      await db.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [id, chapter]);
      await db.query("update public.member_profiles set chapter_id = $1 where id = $2", [chapter, id]);
    }
    const session = randomUUID();
    await db.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [session, id]);
    await db.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), id]);
    ids.sessions[id] = session;
    return id;
  }

  async function organization(label, chapterCount) {
    const org = randomUUID();
    const bootstrap = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [bootstrap, `bootstrap-${bootstrap}@example.invalid`]);
    await db.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $3, $4)", [org, `${label}-${org}`, `Tamarack statistics ${label}`, bootstrap]);
    const chapters = [];
    for (let index = 0; index < chapterCount; index += 1) {
      const chapter = `${label}-${index}-${randomUUID()}`;
      await db.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $2, $1, $3, $4, $5)", [chapter, `Tamarack ${label} chapter ${index + 1}`, index === 0, index + 1, org]);
      chapters.push(chapter);
    }
    return { org, chapters };
  }

  async function members(count, label, org, chapter) {
    const list = [];
    for (let index = 0; index < count; index += 1) list.push(await user(`${label}${index}`, org, chapter));
    return list;
  }

  // A collective action of the organization, and a member's sign-up to it.
  async function collectiveAction(org) {
    const id = randomUUID();
    await fixture(
      "insert into public.digital_actions (id, organization_id, action_kind, title, summary, status, target_count, published_at) values ($1, $2, 'petition', 'Staffing petition', 'Sign for safe staffing.', 'published', 100, now())",
      [id, org],
    );
    return id;
  }

  async function action(userId, org, joinedAt = "now()") {
    const actionId = await collectiveAction(org);
    await fixture(`insert into public.digital_action_participants (organization_id, action_id, user_id, participation_kind, joined_at) values ($1, $2, $3, 'signature', ${joinedAt})`, [org, actionId, userId]);
  }

  // A member's own action-log row (client-writable, no organization): never counted.
  async function loggedAction(userId) {
    await fixture("insert into public.member_action_log (user_id, action_key, action_kind, occurred_at) values ($1, $2, 'vote', now())", [userId, `stats-${randomUUID()}`]);
  }

  async function caseFor(userId, org, chapter, status, outcome = null) {
    const id = randomUUID();
    await fixture(
      "insert into public.member_cases (id, user_id, reference, title, case_type, status, organization_id, chapter_id) values ($1, $2, $3, 'Statistics case', 'grievance', $4, $5, $6)",
      [id, userId, `ST-${id.slice(0, 8)}`, status, org, chapter],
    );
    if (outcome) {
      await fixture(
        "insert into public.member_case_outcomes (case_id, user_id, outcome, summary, recorded_by) values ($1, $2, $3, 'Recorded outcome', $2)",
        [id, userId, outcome],
      );
    }
    return id;
  }

  const setFloor = (org, value) => db.query(
    "insert into public.organization_setting_values (organization_id, setting_key, value, updated_by) values ($1, 'limits.analytics.anonymity_floor', $2::jsonb, $3) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [org, JSON.stringify(value), ids.a1[0]],
  );

  async function as(userId, { aal = "aal2", role = "authenticated" } = {}) {
    await db.query("savepoint caller");
    try {
      const claims = userId ? { sub: userId, role, aal, session_id: ids.sessions[userId] } : { role };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.query(`set local role ${role}`);
      const result = await db.query("select public.get_member_union_statistics() r");
      await db.query("reset role");
      await db.query("release savepoint caller");
      return { code: "", value: result.rows[0].r };
    } catch (error) {
      await db.query("rollback to savepoint caller");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", message: error.message };
    }
  }

  async function statistics(userId) {
    const answer = await as(userId);
    expect(answer.code, answer.message).toBe("");
    return answer.value;
  }

  beforeEach(async () => {
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    ids = { sessions: {} };
    const home = await organization("home", 2);
    ids.org = home.org;
    [ids.chapterBig, ids.chapterSmall] = home.chapters;
    ids.a1 = await members(27, "big", ids.org, ids.chapterBig);
    ids.a2 = await members(3, "small", ids.org, ids.chapterSmall);
    await setFloor(ids.org, 25);
    const away = await organization("away", 1);
    ids.away = away;
    ids.b = await members(12, "away", away.org, away.chapters[0]);
    for (const member of ids.a1) await action(member, ids.org);
    // Twenty-five wins, each a different member of the big chapter.
    for (const member of ids.a1.slice(0, 25)) await caseFor(member, ids.org, ids.chapterBig, "resolved", "upheld");
    // The other organization's rows must never be counted.
    for (const member of ids.b) {
      await action(member, away.org);
      await caseFor(member, away.org, away.chapters[0], "resolved", "denied");
    }
  });
  afterEach(async () => { await db.query("rollback"); });

  it("publishes each breakdown whose every non-zero cell meets the floor, counting only the caller's organization", async () => {
    const value = await statistics(ids.a2[0]);
    const month = easternMonth();
    expect(value).toMatchObject({ available: true, privacyFloor: 25 });
    expect(value.wins.withheld).toBe(false);
    expect(value.wins.months).toHaveLength(12);
    expect(value.wins.months.at(-1)).toEqual({ month, count: 25 });
    expect(value.wins.months.slice(0, -1).every((row) => row.count === 0)).toBe(true);
    expect(value.actions).toMatchObject({ withheld: false });
    expect(value.actions.months.at(-1)).toEqual({ month, count: 27 });
    expect(value.outcomes).toEqual({ withheld: false, rows: [
      { outcome: "upheld", count: 25 }, { outcome: "settled", count: 0 }, { outcome: "withdrawn", count: 0 },
      { outcome: "denied", count: 0 }, { outcome: "other", count: 0 },
    ] });
    expect(value.chapters.openCasesWithheld).toBe(false);
    expect(value.chapters.rows.map((row) => row.id)).toEqual([ids.chapterBig, ids.chapterSmall]);
    // The small chapter's member count is under the floor and is withheld;
    // no resolved-case total is published beside the outcome breakdown.
    expect(value.chapters.rows[0]).toEqual({ id: ids.chapterBig, name: "Tamarack home chapter 1", members: 27, openCases: 0 });
    expect(value.chapters.rows[1]).toEqual({ id: ids.chapterSmall, name: "Tamarack home chapter 2", members: null, openCases: 0 });
    // No person, email or identifier of a member leaves the function.
    const text = JSON.stringify(value);
    for (const member of [...ids.a1, ...ids.a2, ...ids.b]) expect(text).not.toContain(member);
    expect(text).not.toContain(ids.away.chapters[0]);
  });

  it("withholds a whole breakdown when any non-zero cell falls under the floor", async () => {
    // Two denied grievances by two people: the outcome breakdown goes whole.
    await caseFor(ids.a2[0], ids.org, ids.chapterSmall, "resolved", "denied");
    await caseFor(ids.a2[1], ids.org, ids.chapterSmall, "resolved", "denied");
    // One open case by one person: the chapter table's open column goes.
    await caseFor(ids.a2[2], ids.org, ids.chapterSmall, "active");
    // Three people signing up in an earlier month: the actions series goes.
    for (const member of ids.a2) await action(member, ids.org, "now() - interval '2 months'");
    const value = await statistics(ids.a1[0]);
    expect(value.outcomes).toEqual({ withheld: true });
    expect(value.actions).toEqual({ withheld: true });
    expect(value.wins.withheld).toBe(false);
    expect(value.chapters.openCasesWithheld).toBe(true);
    for (const row of value.chapters.rows) expect(row).not.toHaveProperty("openCases");
    expect(value.chapters.rows[0].members).toBe(27);
  });

  it("counts a reopened case neither as a win nor in the outcome breakdown", async () => {
    // #6777: two cases resolved with an outcome and then set back to active
    // keep their outcome rows; they are open grievances, not closed ones.
    await caseFor(ids.a1[25], ids.org, ids.chapterBig, "active", "upheld");
    await caseFor(ids.a1[26], ids.org, ids.chapterBig, "active", "denied");
    const value = await statistics(ids.a2[0]);
    expect(value.wins.months.at(-1)).toEqual({ month: easternMonth(), count: 25 });
    expect(value.outcomes).toEqual({ withheld: false, rows: [
      { outcome: "upheld", count: 25 }, { outcome: "settled", count: 0 }, { outcome: "withdrawn", count: 0 },
      { outcome: "denied", count: 0 }, { outcome: "other", count: 0 },
    ] });
    // They are open cases: two people, under the floor, so that column goes.
    expect(value.chapters.openCasesWithheld).toBe(true);
  });

  it("counts neither a member's own action-log rows nor sign-ups to another organization's actions", async () => {
    // The big chapter's members also belong to the other organization and
    // sign up to its action, and write their own action-log rows.
    for (const member of ids.a1) {
      await db.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids.away.org, member]);
      await action(member, ids.away.org);
      await loggedAction(member);
    }
    const value = await statistics(ids.a1[0]);
    expect(value.actions.months.at(-1)).toEqual({ month: easternMonth(), count: 27 });
  });

  // BUG-UG-MEMBER-UNION-STATISTICS-SURVEY-GATE-20261031: the gate locks
  // a member who owes the quarterly survey out of the figures until it is submitted.
  it("answers a member the quarterly survey gate locks with no figures, and unlocks on submission", async () => {
    const survey = randomUUID();
    await db.query(
      `insert into public.organization_surveys (id, organization_id, title, status, cadence, period_key, created_by)
       values ($1, $2, 'Quarterly check-in', 'open', 'quarterly',
               pg_catalog.to_char(current_date, 'YYYY') || '-Q' || pg_catalog.date_part('quarter', current_date)::integer, $3)`,
      [survey, ids.org, ids.a1[0]],
    );
    expect(await statistics(ids.a1[1])).toEqual({ available: false, locked: true, reason: "quarterly_survey_gate" });
    await db.query(
      "insert into public.organization_survey_sessions (organization_id, survey_id, respondent_user_id, status, submitted_at) values ($1, $2, $3, 'submitted', now())",
      [ids.org, survey, ids.a1[1]],
    );
    expect((await statistics(ids.a1[1])).available).toBe(true);
  });

  it("applies the organization's own floor, never below 25", async () => {
    await setFloor(ids.org, 26);
    let value = await statistics(ids.a1[0]);
    expect(value.privacyFloor).toBe(26);
    expect(value.wins).toEqual({ withheld: true });
    expect(value.actions.withheld).toBe(false);
    await setFloor(ids.org, 28);
    value = await statistics(ids.a1[0]);
    expect(value.privacyFloor).toBe(28);
    expect(value.actions).toEqual({ withheld: true });
    expect(value.chapters.rows[0].members).toBeNull();
    await db.query("delete from public.organization_setting_values where organization_id = $1 and setting_key = 'limits.analytics.anonymity_floor'", [ids.org]);
    value = await statistics(ids.a1[0]);
    expect(value.privacyFloor).toBe(25);
    expect(value.wins.withheld).toBe(false);
  });

  it("answers unavailable to a member of no organization and refuses signed-out, anon and two-step-short callers", async () => {
    const loner = await user("loner");
    expect(await statistics(loner)).toEqual({ available: false });
    expect((await as(null)).code).toBe("42501");
    expect((await as(null, { role: "anon" })).code).toBe("42501");
    expect((await as(ids.a1[0], { aal: "aal1" })).code).toBe("42501");
    const grants = await db.query(
      "select has_function_privilege('anon', 'public.get_member_union_statistics()', 'execute') anon, has_function_privilege('authenticated', 'public.get_member_union_statistics()', 'execute') signed_in",
    );
    expect(grants.rows[0]).toEqual({ anon: false, signed_in: true });
  });
});
