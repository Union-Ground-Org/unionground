// @vitest-environment node
//
// REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030 (#6623)
//
// 20261030224501 adds a chapter seniority list, bid windows, bids and awards.
// The rule under test: a chapter's stewards and coordinators see and edit the
// whole list and its bids; a member sees and questions only their own entry
// and bids; nobody reads the tables directly. Two fictional tenants; every
// refusal has an allowed control; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261030224501_chapter_seniority_and_bids";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const PUBLIC_RPCS = [
  "public.list_chapter_seniority(p_chapter_id text, p_after_date date, p_after_id uuid, p_limit integer)",
  "public.search_chapter_seniority_members(p_chapter_id text, p_query text)",
  "public.save_chapter_seniority_entry(p_chapter_id text, p_user_id uuid, p_seniority_date date, p_classification text, p_tie_break_note text)",
  "public.delete_chapter_seniority_entry(p_entry_id uuid)",
  "public.import_chapter_seniority(p_chapter_id text, p_rows jsonb, p_apply boolean)",
  "public.answer_chapter_seniority_question(p_entry_id uuid, p_answer text)",
  "public.list_chapter_bid_windows(p_chapter_id text, p_limit integer, p_offset integer)",
  "public.list_chapter_bid_deadlines(p_chapter_id text)",
  "public.save_chapter_bid_window(p_id uuid, p_chapter_id text, p_subject text, p_opens_at timestamp with time zone, p_closes_at timestamp with time zone, p_status text)",
  "public.record_chapter_bid(p_window_id uuid, p_user_id uuid, p_choice text)",
  "public.list_chapter_bid_window_bids(p_window_id uuid, p_offset integer, p_limit integer)",
  "public.award_chapter_bid(p_bid_id uuid, p_award text)",
  "public.get_my_seniority()",
  "public.question_my_seniority_entry(p_entry_id uuid, p_note text)",
];

describe("chapter seniority and bids (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("keeps every table private with row-level security forced and no client grant", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    for (const table of ["chapter_seniority_entries", "chapter_bid_windows", "chapter_bid_entries"]) {
      expect(sql).toContain(`create table private.${table} (`);
      expect(sql).toContain(`alter table private.${table} force row level security;`);
      expect(sql).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
    }
    expect(sql).not.toMatch(/create policy|grant (select|insert|update|delete)/i);
  });

  it("puts every staff routine behind the one staff rule and every writer behind the case-graph lock", () => {
    for (const name of ["list_chapter_seniority", "save_chapter_seniority_entry", "import_chapter_seniority", "list_chapter_bid_windows", "save_chapter_bid_window"]) {
      expect(stripComments(fnBody(sql, `public.${name}(`)), name).toContain("private.seniority_staff_can_manage(p_chapter_id)");
    }
    for (const name of ["save_chapter_seniority_entry", "delete_chapter_seniority_entry", "import_chapter_seniority", "answer_chapter_seniority_question", "save_chapter_bid_window", "record_chapter_bid", "award_chapter_bid", "question_my_seniority_entry"]) {
      expect(stripComments(fnBody(sql, `public.${name}(`)), name).toMatch(/^create function public\.\w+\([^)]*\)[\s\S]*?as \$function\$\s*begin\s*perform private\.lock_case_graph\(/);
    }
    const rule = stripComments(fnBody(sql, "private.seniority_staff_can_manage(p_chapter text)"));
    expect(rule).toContain("private.member_has_chapter_role(p_chapter, array['steward', 'coordinator'])");
    expect(rule).toContain("(select private.mfa_satisfied())");
    expect(stripComments(fnBody(sql, "public.question_my_seniority_entry("))).toContain("e.user_id = caller");
  });

  it("registers both member tables in the account lifecycle and pins every routine in the contract", () => {
    expect(sql).toContain("'additionalDomains.chapter_seniority_entries'");
    expect(sql).toContain("'additionalDomains.chapter_bid_entries'");
    expect(sql).toContain("'chapter_bid_entries', private.account_lifecycle_export_chapter_bid_entries(p_caller)");
    for (const sig of PUBLIC_RPCS) {
      expect(contract.functions.find((row) => row.sig === sig), sig).toMatchObject({ secdef: true, exec: "authenticated" });
    }
  });
});

// BUG-UG-BID-RECORDS-STALE-AWARD-AND-500-CAP-20261102 (#6778).
const REPAIR = readFileSync(new URL("../supabase/migrations/20261102181000_bid_award_cleared_on_choice_change_and_bid_pages.sql", import.meta.url), "utf8");

describe("bid award and bid page repair (static)", () => {
  it("clears a stale award in the bid write and pages bids behind the same staff rule", () => {
    expect(REPAIR).toMatch(/\nbegin;\nset local search_path = pg_catalog;\n/);
    expect(REPAIR.trimEnd()).toMatch(/\ncommit;$/);
    const write = REPAIR.slice(REPAIR.indexOf("create or replace function public.record_chapter_bid"), REPAIR.indexOf("create function public.list_chapter_bid_window_bids"));
    expect(write).toContain("perform private.lock_case_graph(array[auth.uid(), p_user_id], array[]::uuid[]);");
    expect(write).toContain("award = case when b.choice is distinct from excluded.choice then null else b.award end");
    expect(write).toContain("awarded_at = case when b.choice is distinct from excluded.choice then null else b.awarded_at end");
    expect(write).toContain("'awardCleared', cleared");
    const page = REPAIR.slice(REPAIR.indexOf("create function public.list_chapter_bid_window_bids"));
    expect(page).toContain("perform private.member_pin_require_full_session();");
    expect(page).toContain("not private.seniority_staff_can_manage(target.chapter_id)");
    expect(page).toContain("order by entry.seniority_date nulls last, entry.id nulls last, x.recorded_at, x.id");
    // Gate r2s3: no offset ceiling, and overflow-safe paging arithmetic.
    expect(page).toContain("skip integer := greatest(0, coalesce(p_offset, 0));");
    expect(page).toContain("case when skip::bigint + cap < total then skip + cap end");
    expect(page).not.toMatch(/least\(coalesce\(p_offset/);
    expect(page).toContain("revoke all on function public.list_chapter_bid_window_bids(uuid, integer, integer) from public, anon, authenticated, service_role;");
    expect(page).toContain("grant execute on function public.list_chapter_bid_window_bids(uuid, integer, integer) to authenticated;");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter seniority and bids on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "chapter-seniority-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const main = `pkt-main-${orgA}`;
    const east = `pkt-east-${orgA}`;
    const other = `cpl-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `pkt-${orgA}`, `Port Kinsey Transit ${orgA}`, orgB, `cpl-${orgB}`, `Copperline Library ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Kinsey Central',$1,'proof',$4,9951), ($2,'East Yard',$2,'proof',$4,9952), ($3,'Main Library',$3,'proof',$5,9953)`,
      [main, east, other, orgA, orgB]);
    return { orgA, orgB, main, east, other };
  }

  async function person(t, chapter, { organization = t.orgA, role = null, name = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, name ?? `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    }
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args = []) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "", detail: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "", detail: error.detail || "" };
    }
  }

  const as = async (userId, statement, args = []) => {
    await actAs(userId);
    const result = await capture(statement, args);
    await asOwner();
    return result;
  };
  const save = (staff, chapter, member, date, classification = null) =>
    as(staff, "select public.save_chapter_seniority_entry($1,$2,$3::date,$4,null) as v", [chapter, member, date, classification]);

  it("keeps an ordered, paged list that only the chapter's stewards and coordinators see", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, t.main, { role: "steward", name: "Pat Steward" });
      const coordinator = await person(t, t.main, { role: "coordinator", name: "Cora Coordinator" });
      const eastSteward = await person(t, t.east, { role: "steward" });
      const foreignSteward = await person(t, t.other, { organization: t.orgB, role: "steward" });
      const a = await person(t, t.main, { name: "Ana Senior" });
      const b = await person(t, t.main, { name: "Ben Middle" });
      const c = await person(t, t.main, { name: "Cy Junior" });
      const eastMember = await person(t, t.east, { name: "East Member" });

      expect((await save(steward, t.main, c, "2019-04-01", "Operator")).ok).toBe(true);
      expect((await save(steward, t.main, a, "2008-01-15", "Operator")).ok).toBe(true);
      expect((await save(coordinator, t.main, b, "2012-06-30", "Mechanic")).ok).toBe(true);
      // Saving again updates the one entry.
      expect((await save(steward, t.main, b, "2012-06-29", "Mechanic")).ok).toBe(true);

      const first = await as(steward, "select public.list_chapter_seniority($1, null, null, 2) as v", [t.main]);
      expect(first.ok, first.message).toBe(true);
      expect(first.value.items.map((row) => [row.name, row.position, row.seniorityDate])).toEqual([["Ana Senior", 1, "2008-01-15"], ["Ben Middle", 2, "2012-06-29"]]);
      expect(first.value.nextCursor).toMatchObject({ afterDate: "2012-06-29" });
      const second = await as(coordinator, "select public.list_chapter_seniority($1, $2::date, $3::uuid, 2) as v", [t.main, first.value.nextCursor.afterDate, first.value.nextCursor.afterId]);
      expect(second.value.items.map((row) => [row.name, row.position])).toEqual([["Cy Junior", 3]]);
      expect(second.value.nextCursor).toBeNull();

      // The picker lists the chapter's members, by name, and who is already listed.
      const picked = await as(steward, "select public.search_chapter_seniority_members($1, 'ben') as v", [t.main]);
      expect(picked.value).toEqual([{ userId: b, name: "Ben Middle", listed: true }]);
      expect((await as(steward, "select public.search_chapter_seniority_members($1, '') as v", [t.main])).value.map((row) => row.name)).not.toContain("East Member");
      expect(await as(a, "select public.search_chapter_seniority_members($1, '') as v", [t.main])).toMatchObject({ ok: false, code: "42501" });

      // An organization-wide coordinator with no chapter of their own may manage it (gate r3).
      const orgCoordinator = randomUUID();
      await client.query("insert into auth.users(id,email) values ($1,$2)", [orgCoordinator, `${orgCoordinator}@example.invalid`]);
      await client.query("update public.member_profiles set chapter_id=null, full_name='Org Coordinator' where id=$1", [orgCoordinator]);
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [t.orgA, orgCoordinator]);
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), orgCoordinator]);
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'coordinator')", [t.orgA, orgCoordinator]);
      const orgWide = await as(orgCoordinator, "select public.list_chapter_seniority($1) as v", [t.main]);
      expect(orgWide.ok, orgWide.message).toBe(true);
      expect(orgWide.value.items).toHaveLength(3);
      // ...but not another organization's chapter.
      expect(await as(orgCoordinator, "select public.list_chapter_seniority($1) as v", [t.other])).toMatchObject({ ok: false, code: "42501" });

      // Refusals: a plain member, another chapter's steward, another organization's steward.
      for (const caller of [a, eastSteward, foreignSteward]) {
        expect(await as(caller, "select public.list_chapter_seniority($1) as v", [t.main]), caller).toMatchObject({ ok: false, code: "42501" });
      }
      // Only members of this chapter can be listed.
      expect(await save(steward, t.main, eastMember, "2010-01-01")).toMatchObject({ ok: false, code: "22023", detail: "seniority_member_required" });
      // Nobody reads the table directly.
      expect(await as(steward, "select count(*) as v from private.chapter_seniority_entries")).toMatchObject({ ok: false, code: "42501" });

      const entryId = first.value.items[1].id;
      expect((await as(steward, "select public.delete_chapter_seniority_entry($1) as v", [entryId])).ok).toBe(true);
      expect((await as(steward, "select public.list_chapter_seniority($1) as v", [t.main])).value.items).toHaveLength(2);
    } finally {
      await client.query("rollback");
    }
  });

  it("previews an import without writing, then applies only the matched rows", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, t.main, { role: "steward" });
      const a = await person(t, t.main, { name: "Ana Senior" });
      const outsider = await person(t, t.east, { name: "East Member" });
      const rows = [
        { email: `${a}@example.invalid`.toUpperCase(), seniorityDate: "2008-01-15", classification: "Operator" },
        { email: `${outsider}@example.invalid`, seniorityDate: "2009-01-01" },
        { email: "nobody@example.invalid", seniorityDate: "2010-01-01" },
        { email: `${a}@example.invalid`, seniorityDate: "2011-02-30" },
        { email: `${a}@example.invalid`, seniorityDate: "2011-01-01" },
      ];
      const preview = await as(steward, "select public.import_chapter_seniority($1, $2::jsonb, false) as v", [t.main, JSON.stringify(rows)]);
      expect(preview.ok, preview.message).toBe(true);
      expect(preview.value).toMatchObject({ applied: false, saved: 0 });
      expect(preview.value.rows.map((row) => row.outcome)).toEqual(["ready", "no_member", "no_member", "invalid_date", "duplicate"]);
      expect(preview.value.rows[0]).toMatchObject({ userId: a, name: "Ana Senior", seniorityDate: "2008-01-15" });
      expect(preview.value.rows[1].userId).toBeNull();
      expect((await as(steward, "select public.list_chapter_seniority($1) as v", [t.main])).value.items).toEqual([]);

      const applied = await as(steward, "select public.import_chapter_seniority($1, $2::jsonb, true) as v", [t.main, JSON.stringify(rows)]);
      expect(applied.value).toMatchObject({ applied: true, saved: 1 });
      expect((await as(steward, "select public.list_chapter_seniority($1) as v", [t.main])).value.items.map((row) => row.userId)).toEqual([a]);
      expect(await as(steward, "select public.import_chapter_seniority($1, '[]'::jsonb, false) as v", [t.main])).toMatchObject({ ok: false, code: "22023" });
      expect(await as(a, "select public.import_chapter_seniority($1, $2::jsonb, false) as v", [t.main, JSON.stringify(rows)])).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });

  it("opens a bid window, records bids beside seniority, and records awards", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, t.main, { role: "steward" });
      const senior = await person(t, t.main, { name: "Ana Senior" });
      const junior = await person(t, t.main, { name: "Cy Junior" });
      await save(steward, t.main, senior, "2008-01-15", "Operator");
      await save(steward, t.main, junior, "2019-04-01", "Operator");

      const created = await as(steward, "select public.save_chapter_bid_window(null, $1, 'November shift bid', now() - interval '1 day', now() + interval '3 days', 'open') as v", [t.main]);
      expect(created.ok, created.message).toBe(true);
      const windowId = created.value.id;
      expect((await as(steward, "select public.record_chapter_bid($1, $2, 'Day run 12') as v", [windowId, junior])).ok).toBe(true);
      expect((await as(steward, "select public.record_chapter_bid($1, $2, 'Day run 12') as v", [windowId, senior])).ok).toBe(true);

      const listed = await as(steward, "select public.list_chapter_bid_windows($1) as v", [t.main]);
      expect(listed.ok, listed.message).toBe(true);
      const bids = listed.value.windows[0].bids;
      expect(bids.map((bid) => [bid.name, bid.seniorityDate])).toEqual([["Ana Senior", "2008-01-15"], ["Cy Junior", "2019-04-01"]]);
      expect((await as(steward, "select public.award_chapter_bid($1, 'Day run 12') as v", [bids[0].id])).ok).toBe(true);
      expect((await as(steward, "select public.list_chapter_bid_windows($1) as v", [t.main])).value.windows[0].bids[0]).toMatchObject({ award: "Day run 12" });

      // A window that is no longer open takes no new bid; a bad window is refused.
      await as(steward, "select public.save_chapter_bid_window($1, $2, 'November shift bid', now() - interval '1 day', now() + interval '3 days', 'awarded') as v", [windowId, t.main]);
      expect(await as(steward, "select public.record_chapter_bid($1, $2, 'Night run 4') as v", [windowId, junior])).toMatchObject({ ok: false, detail: "bid_window_closed" });
      expect(await as(steward, "select public.save_chapter_bid_window(null, $1, 'Bad', now(), now() - interval '1 day', 'open') as v", [t.main])).toMatchObject({ ok: false, code: "22023" });
      expect(await as(junior, "select public.list_chapter_bid_windows($1) as v", [t.main])).toMatchObject({ ok: false, code: "42501" });

      // A window that has not opened yet, or has closed by the clock, takes no bid (gate r1).
      const later = await as(steward, "select public.save_chapter_bid_window(null, $1, 'December shift bid', now() + interval '2 days', now() + interval '5 days', 'open') as v", [t.main]);
      expect(await as(steward, "select public.record_chapter_bid($1, $2, 'Day run 1') as v", [later.value.id, junior])).toMatchObject({ ok: false, detail: "bid_window_closed" });
      const past = await as(steward, "select public.save_chapter_bid_window(null, $1, 'October shift bid', now() - interval '5 days', now() - interval '1 day', 'open') as v", [t.main]);
      expect(await as(steward, "select public.record_chapter_bid($1, $2, 'Day run 1') as v", [past.value.id, junior])).toMatchObject({ ok: false, detail: "bid_window_closed" });
      // Deadlines: open windows closing within 30 days, soonest first.
      const deadlines = await as(steward, "select public.list_chapter_bid_deadlines($1) as v", [t.main]);
      expect(deadlines.value.map((row) => row.subject)).toEqual(["December shift bid"]);
      expect(await as(junior, "select public.list_chapter_bid_deadlines($1) as v", [t.main])).toMatchObject({ ok: false, code: "42501" });
      // Bids listed most senior first, with the total.
      expect((await as(steward, "select public.list_chapter_bid_windows($1) as v", [t.main])).value.windows.find((row) => row.id === windowId).bidCount).toBe(2);

      // The member sees their own bid and nobody else's.
      const mine = await as(junior, "select public.get_my_seniority() as v");
      expect(mine.value.bids).toEqual([expect.objectContaining({ subject: "November shift bid", choice: "Day run 12", award: null })]);
    } finally {
      await client.query("rollback");
    }
  });

  it("clears an award when the bid's choice changes, and pages every bid of a window (#6778)", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, t.main, { role: "steward" });
      const senior = await person(t, t.main, { name: "Ana Senior" });
      const junior = await person(t, t.main, { name: "Cy Junior" });
      const third = await person(t, t.main, { name: "Dee Third" });
      await save(steward, t.main, senior, "2008-01-15", "Operator");
      await save(steward, t.main, junior, "2019-04-01", "Operator");
      const created = await as(steward, "select public.save_chapter_bid_window(null, $1, 'November shift bid', now() - interval '1 day', now() + interval '3 days', 'open') as v", [t.main]);
      const windowId = created.value.id;
      for (const [who, choice] of [[senior, "Day run 12"], [junior, "Night run 4"], [third, "Weekend 2"]]) {
        expect((await as(steward, "select public.record_chapter_bid($1, $2, $3) as v", [windowId, who, choice])).ok).toBe(true);
      }
      const first = (await as(steward, "select public.list_chapter_bid_windows($1) as v", [t.main])).value.windows[0].bids;
      expect((await as(steward, "select public.award_chapter_bid($1, 'Day run 12') as v", [first[0].id])).ok).toBe(true);
      // The same choice again keeps the award; a new choice clears it.
      expect((await as(steward, "select public.record_chapter_bid($1, $2, 'Day run 12') as v", [windowId, senior])).value).toEqual({ id: first[0].id, awardCleared: false });
      expect((await as(steward, "select public.list_chapter_bid_windows($1) as v", [t.main])).value.windows[0].bids[0]).toMatchObject({ choice: "Day run 12", award: "Day run 12" });
      expect((await as(steward, "select public.record_chapter_bid($1, $2, 'Day run 14') as v", [windowId, senior])).value).toEqual({ id: first[0].id, awardCleared: true });
      expect((await as(steward, "select public.list_chapter_bid_windows($1) as v", [t.main])).value.windows[0].bids[0]).toMatchObject({ choice: "Day run 14", award: null, awardedAt: null });

      // Pages continue the first list's order; every bid is reachable.
      const page = await as(steward, "select public.list_chapter_bid_window_bids($1, 1, 1) as v", [windowId]);
      expect(page.ok, page.message).toBe(true);
      expect(page.value).toMatchObject({ windowId, total: 3, nextOffset: 2 });
      expect(page.value.bids.map((bid) => bid.name)).toEqual(["Cy Junior"]);
      const rest = await as(steward, "select public.list_chapter_bid_window_bids($1, 2, 100) as v", [windowId]);
      expect(rest.value).toMatchObject({ total: 3, nextOffset: null });
      expect(rest.value.bids.map((bid) => bid.name)).toEqual(["Dee Third"]);
      expect((await as(steward, "select public.award_chapter_bid($1, 'Weekend 2') as v", [rest.value.bids[0].id])).ok).toBe(true);
      // Only the chapter's staff read it.
      expect(await as(junior, "select public.list_chapter_bid_window_bids($1) as v", [windowId])).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });

  it("shows a member only their own entry, and lets them question it", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, t.main, { role: "steward" });
      const a = await person(t, t.main, { name: "Ana Senior" });
      const b = await person(t, t.main, { name: "Ben Middle" });
      await save(steward, t.main, a, "2008-01-15", "Operator");
      await save(steward, t.main, b, "2012-06-29", "Mechanic");
      const entries = (await as(steward, "select public.list_chapter_seniority($1) as v", [t.main])).value.items;

      const own = await as(a, "select public.get_my_seniority() as v");
      expect(own.ok, own.message).toBe(true);
      expect(own.value.entries).toEqual([expect.objectContaining({ id: entries[0].id, seniorityDate: "2008-01-15", classification: "Operator", chapterName: "Kinsey Central", question: null })]);
      expect(JSON.stringify(own.value)).not.toContain("Ben Middle");

      expect(await as(a, "select public.question_my_seniority_entry($1, 'My start date was January 8.') as v", [entries[1].id])).toMatchObject({ ok: false, code: "P0002" });
      expect((await as(a, "select public.question_my_seniority_entry($1, 'My start date was January 8.') as v", [entries[0].id])).ok).toBe(true);
      const staffView = await as(steward, "select public.list_chapter_seniority($1) as v", [t.main]);
      expect(staffView.value.openQuestions).toBe(1);
      expect(staffView.value.items[0].question).toMatchObject({ status: "open", note: "My start date was January 8." });
      expect(await as(a, "select public.answer_chapter_seniority_question($1, 'Corrected.') as v", [entries[0].id])).toMatchObject({ ok: false, code: "42501" });
      expect((await as(steward, "select public.answer_chapter_seniority_question($1, 'Corrected to January 8.') as v", [entries[0].id])).ok).toBe(true);
      expect((await as(a, "select public.get_my_seniority() as v")).value.entries[0].question).toMatchObject({ status: "answered", answer: "Corrected to January 8." });
      expect(await as(steward, "select public.answer_chapter_seniority_question($1, 'Again') as v", [entries[0].id])).toMatchObject({ ok: false, detail: "seniority_no_open_question" });
    } finally {
      await client.query("rollback");
    }
  });
});
