// @vitest-environment node
//
// REQ-UG-OFFICER-BUDGET-AND-MEETING-AGENDA-20261006 (partial delivery)
//
// Owner decision, October 8, 2026 (question 8, option A): a meeting gets an
// agenda field, minutes attach to the meeting, and the officer budget is held.
// 20261008121000 adds member_events.agenda (staff only, no member column
// grant), set_member_event_agenda, chapter_records.event_id and
// attach_minutes_to_meeting, and get_admin_events returns both. Static checks
// always run; the live cases run on a disposable database inside one rolled
// back transaction each.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261008121000_meeting_agenda_minutes";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("meeting agenda and minutes (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("is one atomic migration that touches no budget and adds no case-graph foreign key", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/budget/i);
    expect(sql).not.toMatch(/\breferences\b/i);
    expect(sql).toContain("add column event_id text;");
  });

  it("gives members no column grant on the agenda and gates both writers to staff", () => {
    expect(sql).not.toMatch(/grant select \([^)]*agenda[^)]*\) on public\.member_events/);
    const agenda = stripComments(fnBody(sql, "public.set_member_event_agenda(p_id text, p_agenda text)"));
    expect(agenda).toContain("not private.member_can_manage_events()");
    expect(agenda).toContain("where id = p_id and chapter_id = caller_chapter\n  for update;");
    const attach = stripComments(fnBody(sql, "public.attach_minutes_to_meeting(p_record_id uuid, p_event_id text)"));
    // The definer MFA audit (scripts/verify-db-contract.mjs) needs a direct
    // assurance proof ahead of the chapter context.
    expect(attach.indexOf("if not private.mfa_satisfied() then")).toBeGreaterThan(-1);
    expect(attach.indexOf("if not private.mfa_satisfied() then")).toBeLessThan(attach.indexOf("institutional_context(true)"));
    expect(attach).toContain("from private.institutional_context(true);");
    expect(attach).toContain("and record_type = 'minutes' and archived_at is null");
    expect(attach).toContain("where id = clean_event and chapter_id = ctx.chapter_id;");
    for (const sig of ["set_member_event_agenda(text, text)", "attach_minutes_to_meeting(uuid, text)"]) {
      expect(sql).toContain(`revoke all on function public.${sig} from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
  });

  it("pins the new functions and the widened events desk read in the database contract", () => {
    const names = contract.functions.map((row) => row.sig);
    // 20261104110000 (REQ-UG-LEARNING-PERIOD-EVENTS-20261103) gives
    // the agenda setter an expected version; the two-argument form is absent.
    expect(names).toEqual(expect.arrayContaining([
      "public.set_member_event_agenda(p_id text, p_agenda text, p_expected_version integer)",
      "public.attach_minutes_to_meeting(p_record_id uuid, p_event_id text)",
    ]));
    const desk = contract.functions.find((row) => row.sig === "public.get_admin_events()");
    expect(desk.bodyContains).toEqual(expect.arrayContaining(["'agenda', e.agenda,", "cr.record_type = 'minutes' and cr.archived_at is null"]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

async function seed(client) {
  const ids = Object.fromEntries(["org", "admin", "adminSession", "member", "memberSession"].map((key) => [key, randomUUID()]));
  ids.chapter = `mam-${ids.org}`;
  ids.otherChapter = `mam-other-${ids.org}`;
  const people = [[ids.admin, ids.adminSession, ["admin"]], [ids.member, ids.memberSession, []]];
  for (const [user, session] of people) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic agenda factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `mam-${ids.org}`, ids.admin]);
  await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9950),($3,$3,$3,$2,false,9951)", [ids.chapter, ids.org, ids.otherChapter]);
  for (const [user, , roles] of people) {
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, ids.chapter, `Agenda Person ${user.slice(0, 8)}`]);
    for (const role of roles) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids.org, user, role]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids.chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids.chapter]);
    }
  }
  return ids;
}

async function withFixture(run) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "meeting-agenda-minutes-rollback-proof" });
  await client.connect();
  await client.query("begin");
  try {
    await client.query("set local statement_timeout = '60s'");
    const ids = await seed(client);
    const sessions = { [ids.admin]: ids.adminSession, [ids.member]: ids.memberSession };
    const as = async (user, aal = "aal2") => {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({ role: "authenticated", sub: user, session_id: sessions[user], aal })]);
      await client.query("set local role authenticated");
    };
    const asOwner = async () => {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims','',true)");
    };
    let savepoint = 0;
    const refused = async (statement, params) => {
      const label = `mam_${++savepoint}`;
      await client.query(`savepoint ${label}`);
      let caught;
      try { await client.query(statement, params); } catch (error) { caught = error; }
      finally { await client.query(`rollback to savepoint ${label}`); await client.query(`release savepoint ${label}`); }
      expect(caught, "statement should have been refused").toBeDefined();
      return caught;
    };
    const one = async (statement, params) => (await client.query(statement, params)).rows[0];
    const meeting = async (chapter = ids.chapter) => {
      await asOwner();
      const id = `mam-meeting-${randomUUID().slice(0, 12)}`;
      await client.query(
        "insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id) values($1,'General meeting',now()+interval '2 days','Hall','Monthly meeting','SG-MAM123',(select coalesce(max(order_index),0)+1 from public.member_events where chapter_id=$2),$2)",
        [id, chapter]);
      return id;
    };
    const desk = async () => (await one("select public.get_admin_events() as v")).v;
    await run(client, ids, { as, asOwner, refused, one, meeting, desk });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

live("meeting agenda and minutes on a disposable database", () => {
  it("lets chapter staff set, read and clear a meeting agenda that members cannot read", async () => {
    await withFixture(async (client, ids, { as, asOwner, refused, one, meeting, desk }) => {
      const eventId = await meeting();
      const otherEvent = await meeting(ids.otherChapter);
      await as(ids.admin);
      const saved = (await one("select public.set_member_event_agenda($1,$2) as v", [eventId, "  1. Call to order\n2. Grievance report\n\t3. Elections  "])).v;
      // The version it leaves (REQ-UG-LEARNING-PERIOD-EVENTS-20261103).
      expect(saved).toEqual({ updated: true, agenda: "1. Call to order\n2. Grievance report\n\t3. Elections", version: 2 });
      expect((await desk()).find((event) => event.id === eventId)).toMatchObject({ agenda: saved.agenda, minutes: [] });
      expect((await one("select public.set_member_event_agenda($1,$2) as v", [eventId, saved.agenda])).v).toMatchObject({ updated: false });
      await asOwner();
      expect((await one("select count(*)::int n from public.member_admin_audit where actor=$1 and action='update_event' and detail->>'eventId'=$2 and detail->'fields' = '[\"agenda\"]'::jsonb", [ids.admin, eventId])).n).toBe(1);
      await as(ids.admin);

      expect((await refused("select public.set_member_event_agenda($1,'Other chapter agenda')", [otherEvent])).message).toBe("unknown event");
      expect((await refused("select public.set_member_event_agenda($1,$2)", [eventId, `Agenda${String.fromCharCode(7)}`])).message).toBe("invalid agenda");
      expect((await refused("select public.set_member_event_agenda($1,$2)", [eventId, "x".repeat(4001)])).code).toBe("22023");

      await as(ids.member);
      expect((await refused("select public.set_member_event_agenda($1,'Member agenda')", [eventId])).code).toBe("42501");
      expect((await refused("select agenda from public.member_events where id=$1", [eventId])).code).toBe("42501");
      expect((await one("select title from public.member_events where id=$1", [eventId])).title).toBe("General meeting");

      await as(ids.admin);
      expect((await one("select public.set_member_event_agenda($1,'   ') as v", [eventId])).v).toEqual({ updated: true, agenda: null, version: 3 });
      expect((await desk()).find((event) => event.id === eventId).agenda).toBeNull();
    });
  });

  it("attaches unarchived minutes to a meeting of the same chapter, shows them on the desk and detaches them", async () => {
    await withFixture(async (client, ids, { as, asOwner, refused, one, meeting, desk }) => {
      const eventId = await meeting();
      const otherEvent = await meeting(ids.otherChapter);
      await as(ids.admin);
      const record = (await one("select public.save_institutional_record(null,'minutes','October minutes','Members approved the agenda',now(),'chapter','save') as v")).v;
      const milestone = (await one("select public.save_institutional_record(null,'milestone','Charter adopted','Adopted',now(),'chapter','save') as v")).v;

      expect((await one("select public.attach_minutes_to_meeting($1,$2) as v", [record.id, eventId])).v).toEqual({ updated: true, eventId });
      expect((await desk()).find((event) => event.id === eventId).minutes).toEqual([{ id: record.id, title: "October minutes" }]);
      await asOwner();
      expect((await one("select count(*)::int n from public.member_admin_audit where actor=$1 and action='update_event' and detail->>'recordId'=$2 and (detail->>'attached')::boolean", [ids.admin, record.id])).n).toBe(1);
      await as(ids.admin);

      expect((await refused("select public.attach_minutes_to_meeting($1,$2)", [record.id, otherEvent])).message).toBe("unknown event");
      expect((await refused("select public.attach_minutes_to_meeting($1,$2)", [milestone.id, eventId])).message).toBe("unknown minutes record");
      // A staff session that has not passed its second factor is refused first.
      await as(ids.admin, "aal1");
      const unverified = await refused("select public.attach_minutes_to_meeting($1,$2)", [record.id, eventId]);
      expect([unverified.code, unverified.message]).toEqual(["42501", "authentication required"]);
      await as(ids.member);
      expect((await refused("select public.attach_minutes_to_meeting($1,$2)", [record.id, null])).code).toBe("42501");
      expect((await refused("select public.get_admin_events()")).code).toBe("42501");

      await as(ids.admin);
      expect((await one("select public.attach_minutes_to_meeting($1,null) as v", [record.id])).v).toEqual({ updated: true, eventId: null });
      expect((await desk()).find((event) => event.id === eventId).minutes).toEqual([]);
      await asOwner();
      expect((await one("select detail->>'title' as title from public.member_admin_audit where actor=$1 and detail->>'recordId'=$2 and not (detail->>'attached')::boolean", [ids.admin, record.id])).title).toBe("General meeting");
    });
  });
});
