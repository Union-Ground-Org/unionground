// @vitest-environment node
// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a, gate round 1
// (stage 560): on a disposable migrated database, every reader of a case's
// deadlines counts each one on the zone it was set in, an undo puts back that
// zone, a fingerprint taken before the zone was stored still matches, and a
// member's own intake checks its dates on the member's group.
//
// The functions under test are re-created inside the rolled-back transaction
// with now() fixed at 2026-12-01 12:00 UTC: December 2 in Pacific/Kiritimati,
// December 1 in Pacific/Pago_Pago and in New York. Two fictional groups sit
// in those two zones.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const SWITCH = "features.governance.group_time_zones";
const EAST = "Pacific/Kiritimati";
const WEST = "Pacific/Pago_Pago";
const INSTANT = "2026-12-01T12:00:00Z";

live("the readers of a case's deadlines, on the zone each deadline was set in", () => {
  let db;
  let w;
  const q = (text, values = []) => db.query(text, values);
  const one = async (text, values = []) => (await q(text, values)).rows[0]?.v;

  // Every function given is re-created with now() fixed at the instant.
  async function at(instant, signatures) {
    for (const signature of signatures) {
      const definition = await one("select pg_get_functiondef($1::regprocedure) v", [signature]);
      await q(definition.replace(/\b(?:pg_catalog\.)?now\(\)/giu, `('${instant}'::timestamptz)`));
    }
  }
  async function as(user, sql, params = []) {
    await q("savepoint reader_call");
    try {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: w.sessions[user], aal: "aal2" })]);
      await q("set local role authenticated");
      const result = await q(sql, params);
      await q("reset role");
      await q("release savepoint reader_call");
      return { data: result.rows[0]?.data };
    } catch (error) {
      await q("rollback to savepoint reader_call");
      await q("release savepoint reader_call");
      return { code: error.code, message: error.message };
    }
  }
  const setting = (key, value) => q(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [w.org, key, JSON.stringify(value)],
  );
  async function account(chapter, roles = []) {
    const id = randomUUID();
    w.sessions[id] = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.org, id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapter]);
    await q("update public.member_profiles set chapter_id=$2, full_name='Fictional Zone Member', language='en' where id=$1", [id, chapter]);
    await q("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [w.sessions[id], id]);
    await q("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Zone proof','totp','verified',now(),now())", [randomUUID(), id]);
    for (const role of roles) {
      await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await q("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [w.org, id, role]);
    }
    return id;
  }
  async function memberCase(owner, deadline = null) {
    const id = randomUUID();
    await q(`insert into public.member_cases(id,user_id,reference,title,case_type,articles,step,deadline,steward_user_id,status)
      values ($1,$2,$3,'Fictional schedule question','Other','','Intake',$4::date,$5,'active')`, [id, owner, `ZR-${id.slice(0, 8)}`, deadline, w.steward]);
    return id;
  }
  async function stepDeadline(caseId, dueAt, kind = "filing") {
    const id = randomUUID();
    await q(`insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by)
      values ($1,$2,$3,$4,$5,'Step 1',$6::timestamptz,$7)`, [id, caseId, w.org, w.west, kind, dueAt, w.steward]);
    return id;
  }

  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "case-deadline-zone-readers-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    await releaseCalendarHolds(db);
    w = { org: randomUUID(), sessions: {} };
    w.east = `zr-east-${w.org}`;
    w.west = `zr-west-${w.org}`;
    await q("insert into public.organizations(id,slug,name,time_zone) values ($1::uuid,$1::text,'Fictional Zone Local',$2)", [w.org, EAST]);
    await q("insert into public.chapters(id,name,slug,organization_id,order_index,time_zone) values ($1,'East chapter',$1,$3,987471,null),($2,'West chapter',$2,$3,987472,$4)", [w.east, w.west, w.org, WEST]);
    w.steward = await account(w.west, ["steward"]);
    w.member = await account(w.west);
    w.eastMember = await account(w.east);
    await migrateLegacyStewardFixtures(db);
    await q("update public.platform_setting_definitions set release_at = null where key = $1", [SWITCH]);
    for (const key of ["features.casework.next_action_queue", "features.attention.guided_portal", "features.attention.dashboard", "features.casework.strength_auto_suggest"]) {
      await setting(key, true);
    }
  }, 120_000);

  afterEach(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("counts a next deadline's days on that deadline's own zone in both staff queues and in case strength", async () => {
    // The case was set in the west; its group has moved east since, where its step deadline was set.
    const caseId = await memberCase(w.member);
    expect(await one("select time_zone v from public.member_cases where id=$1", [caseId])).toBe(WEST);
    await q("update public.chapters set time_zone=$2 where id=$1", [w.west, EAST]);
    // 11 PM December 2 in Kiritimati: due today there, though it is still December 1 in the case's zone.
    const step = await stepDeadline(caseId, "2026-12-02T09:00:00Z");
    expect(await one("select time_zone v from public.casework_deadlines where id=$1", [step])).toBe(EAST);
    await at(INSTANT, ["private.case_next_deadline(uuid,date,text)", "public.get_case_queue_next_actions(text,integer)",
      "public.get_steward_attention_queue(text)", "public.casework_suggest_case_strength(uuid,text)"]);
    const queue = await as(w.steward, "select public.get_case_queue_next_actions('steward', 25) data");
    expect(queue.code).toBeUndefined();
    const risk = queue.data.items.find((item) => item.kind === "deadline_risk" && item.caseId === caseId);
    expect(risk).toMatchObject({ days: 0, dueKind: "step", dueDate: "2026-12-02", severity: "critical" });
    const attention = await as(w.steward, "select public.get_steward_attention_queue('steward') data");
    expect(attention.code).toBeUndefined();
    expect(attention.data.members.find((row) => row.caseId === caseId)).toMatchObject({ days: 0, reasons: ["deadline_risk", "open_case"] });
    const strength = await as(w.steward, "select public.casework_suggest_case_strength($1, 'none') data", [caseId]);
    expect(strength.code).toBeUndefined();
    expect(strength.data.daysRemaining).toBe(0);
  });

  it("finds no reader that still compares a case or step deadline with New York's day", async () => {
    // A line that reads a deadline and an Eastern day together, with no fixed-zone reason.
    const rows = (await q(`
      select p.oid::regprocedure::text as fn
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and exists (select 1 from pg_catalog.regexp_split_to_table(p.prosrc, E'\\n') line
                      where line ~ '(\\.deadline\\y|\\ydue_at\\y|casework_deadlines)'
                        and line ~ '(eastern_day\\s*\\(|America/New_York)'
                        and line !~ 'fixed-zone:')
       order by 1`)).rows.map((row) => row.fn);
    expect(rows).toEqual([]);
  });

  it("keeps a constant deadline range on the staff sweep's case branch, so the (status, deadline) index bounds it", async () => {
    // #9678 round 1 (r1s2/r2s2): each case's own-zone day decides, but a range
    // that does not depend on the row lets the planner use the index.
    const definition = await one("select pg_get_functiondef('private.staff_deadline_notice_sweep()'::regprocedure) v");
    expect(definition).toContain("and c.deadline between v_today - 2 and v_today + 32");
    const zoneDay = "c.deadline between private.local_day(c.time_zone, pg_catalog.now()) and private.local_day(c.time_zone, pg_catalog.now()) + 30";
    const indexCond = async (where) => {
      const plan = (await q(`explain (format json) select c.id from public.member_cases c where c.status = 'active' and ${where}`, ["2026-12-01"])).rows[0]["QUERY PLAN"][0].Plan;
      expect(plan["Index Name"]).toBe("member_cases_status_deadline_idx");
      return plan["Index Cond"];
    };
    // Only the (status, deadline) index is left to choose, inside this rolled-back transaction.
    await q("drop index public.member_cases_dashboard_open_idx");
    await q("set local enable_seqscan = off");
    await q("set local enable_bitmapscan = off");
    // The row's own zone alone bounds nothing on the index; the constant range does.
    expect(await indexCond(`$1::date is not null and ${zoneDay}`)).not.toMatch(/deadline/u);
    expect(await indexCond(`c.deadline between $1::date - 2 and $1::date + 32 and ${zoneDay}`)).toMatch(/deadline >= .*deadline <= /u);
  });

  it("keeps a practice action recorded before the zone was stored undoable", async () => {
    const caseId = await memberCase(w.member);
    const step = await stepDeadline(caseId, "2026-12-05T12:00:00Z");
    // What the fingerprint was before this migration: the row had no zone.
    const before = await one(`select (pg_catalog.to_jsonb(d) - 'time_zone') - array['updated_at', 'reminder_sent_at', 'reminder_disposition']::text[] v
      from public.casework_deadlines d where d.id = $1`, [step]);
    expect(await one("select private.learning_casework_row_state('casework_deadlines', $1) v", [step])).toEqual(before);
  });

  it("puts back the zone a restored deadline was set in when a practice action is undone", async () => {
    const caseId = await memberCase(w.member);
    const step = await stepDeadline(caseId, "2026-12-05T12:00:00Z");
    await q("update public.chapters set time_zone='America/Chicago' where id=$1", [w.west]);
    const extend = async () => {
      await q("update public.casework_deadlines set due_at = due_at + interval '3 days' where id=$1", [step]);
      return one("select max(v.id) v from private.casework_record_versions v where v.record_table = 'casework_deadlines' and v.record_id = $1", [step]);
    };
    const undo = (version) => q("select private.learning_undo_casework('apply', $1::jsonb)",
      [JSON.stringify({ target_table: "public.casework_deadlines", target_id: step, before_ref: version })]);
    const row = () => q("select due_at, time_zone from public.casework_deadlines where id=$1", [step]).then((r) => r.rows[0]);
    let version = await extend();
    expect((await row()).time_zone).toBe("America/Chicago");
    await undo(version);
    expect(await row()).toEqual({ due_at: new Date("2026-12-05T12:00:00Z"), time_zone: WEST });
    // An image recorded before zones were stored restores New York's zone.
    version = await extend();
    await q("update private.casework_record_versions set old_row = old_row - 'time_zone' where id = $1", [version]);
    await undo(version);
    expect(await row()).toEqual({ due_at: new Date("2026-12-05T12:00:00Z"), time_zone: "America/New_York" });
    // An undo that leaves the moment as it was takes its restore with it: a
    // later move in the same transaction takes the group's zone now (final, stage 568B).
    await q("update public.casework_deadlines set label = 'Fictional renamed' where id=$1", [step]);
    version = await one("select max(v.id) v from private.casework_record_versions v where v.record_table = 'casework_deadlines' and v.record_id = $1", [step]);
    await undo(version);
    expect(await one("select pg_catalog.current_setting('unionground.case_deadline_zone_restore', true) v")).toBe("");
    await q("update public.casework_deadlines set due_at = due_at + interval '1 day' where id=$1", [step]);
    expect((await row()).time_zone).toBe("America/Chicago");
    await q("update public.casework_deadlines set due_at = due_at - interval '1 day' where id=$1", [step]);
    // A case's own deadline: the token is for one row, once.
    // A restore taken by a write that leaves the deadline alone is spent all the same.
    await q("select private.restore_case_deadline_zone('member_cases', $1, '{\"time_zone\": \"Asia/Tokyo\"}'::jsonb)", [caseId]);
    await q("update public.member_cases set title='Fictional renamed' where id=$1", [caseId]);
    expect(await one("select pg_catalog.current_setting('unionground.case_deadline_zone_restore', true) v")).toBe("");
    await q("select private.restore_case_deadline_zone('member_cases', $1, '{\"time_zone\": \"Asia/Tokyo\"}'::jsonb)", [caseId]);
    await q("update public.member_cases set deadline='2026-12-09' where id=$1", [caseId]);
    expect(await one("select time_zone v from public.member_cases where id=$1", [caseId])).toBe("Asia/Tokyo");
    await q("update public.member_cases set deadline='2026-12-10' where id=$1", [caseId]);
    expect(await one("select time_zone v from public.member_cases where id=$1", [caseId])).toBe("America/Chicago");
    // Ordinary callers cannot reach the restore.
    expect(await one("select has_function_privilege('authenticated', 'private.restore_case_deadline_zone(text,uuid,jsonb)', 'execute') v")).toBe(false);
  });

  it("checks a member's own intake dates on the member's group", async () => {
    await at(INSTANT, ["public.open_member_case(uuid,text,text,text,date,text,date,text,text,boolean)", "public.create_member_case(text,date,text,text)"]);
    const open = (incident) => as(w.eastMember, "select public.open_member_case(null, 'Fictional schedule question', 'Other', '', null, null, $1::date, null, null, true) data", [incident]);
    // Tomorrow in Kiritimati is December 3, while New York is still on December 1.
    expect((await open("2026-12-03")).code).toBeUndefined();
    expect(await open("2026-12-04")).toMatchObject({ code: "22023", message: "incident date out of range" });
  });
});
