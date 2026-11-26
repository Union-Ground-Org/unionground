// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: on a
// disposable migrated database, a case and each step deadline keep the zone
// of their group when they are set, keep it until the deadline is set again,
// and the deadline notices count each one on that zone. While the switch is
// held every zone is New York's, as before. Two fictional groups sit 25 hours
// apart (Pacific/Kiritimati, UTC+14, and Pacific/Pago_Pago, UTC-11), so their
// dates differ at every moment and each assertion holds whenever it runs.
// Everything runs in one transaction per test that rolls back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const SWITCH = "features.governance.group_time_zones";
const EAST = "Pacific/Kiritimati";
const WEST = "Pacific/Pago_Pago";

live("a case's deadlines on its group's clock", () => {
  let db;
  let w;
  const q = (text, values = []) => db.query(text, values);
  const one = async (text, values = []) => (await q(text, values)).rows[0]?.v;
  const today = (zone) => one("select private.local_day($1, now())::text v", [zone]);
  const release = (released) => q("update public.platform_setting_definitions set release_at = $2 where key = $1", [SWITCH, released ? null : "infinity"]);

  async function person(chapter, staff = false) {
    const id = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [randomUUID(), id]);
    await q("update public.member_profiles set chapter_id=$2,language='en' where id=$1", [id, chapter]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [w.org, id]);
    if (staff) {
      await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [id, chapter]);
      await q("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [id, chapter]);
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [w.org, id]);
      await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    return id;
  }
  // The case's organization and chapter come from its member, as in every app path.
  async function caseFor(member, deadline, steward = null) {
    const id = randomUUID();
    await q(`insert into public.member_cases(id,user_id,reference,title,case_type,step,deadline,steward_user_id)
      values ($1,$2,$3,'Fictional schedule question','Other','Intake',$4::date,$5)`, [id, member, `Z-${id.slice(0, 8)}`, deadline, steward]);
    return id;
  }
  async function stepDeadline(caseId, chapter, dueAt) {
    const id = randomUUID();
    await q(`insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by,time_zone)
      values ($1,$2,$3,$4,'response','Fictional response',$5::timestamptz,$6,'Europe/Lisbon')`, [id, caseId, w.org, chapter, dueAt, w.steward]);
    return id;
  }
  const caseZone = (id) => one("select time_zone v from public.member_cases where id=$1", [id]);
  const stepZone = (id) => one("select time_zone v from public.casework_deadlines where id=$1", [id]);

  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "case-deadline-time-zones-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '60s'");
    w = { org: randomUUID() };
    w.east = `zone-east-${w.org}`;
    w.west = `zone-west-${w.org}`;
    await q("insert into public.organizations(id,slug,name,time_zone) values ($1::uuid,$1::text,'Fictional Zone Local',$2)", [w.org, EAST]);
    await q("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,'East chapter',$1,$3,987461),($2,'West chapter',$2,$3,987462)", [w.east, w.west, w.org]);
    await q("update public.chapters set time_zone=$2 where id=$1", [w.west, WEST]);
    w.eastMember = await person(w.east);
    w.westMember = await person(w.west);
    w.steward = await person(w.west, true);
  }, 120_000);

  afterEach(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("gives every case and step deadline New York's zone while the switch is held", async () => {
    await release(false);
    const id = await caseFor(w.westMember, await today(WEST));
    expect(await caseZone(id)).toBe("America/New_York");
    expect(await stepZone(await stepDeadline(id, w.west, "2026-12-01T12:00:00Z"))).toBe("America/New_York");
    expect(await one("select private.record_time_zone($1::uuid, $2::text) v", [w.org, w.west])).toBe("America/New_York");
  });

  it("sets the group's zone when a deadline is set, and keeps it until it is set again", async () => {
    await release(true);
    const east = await caseFor(w.eastMember, "2026-12-15");
    const west = await caseFor(w.westMember, "2026-12-15");
    expect([await caseZone(east), await caseZone(west)]).toEqual([EAST, WEST]);
    // The trigger owns the column: a direct write does not stick.
    await q("update public.member_cases set time_zone='Asia/Tokyo', title='Fictional renamed' where id=$1", [west]);
    expect(await caseZone(west)).toBe(WEST);
    // A zone changed later applies to what is set afterwards.
    await q("update public.chapters set time_zone='America/Chicago' where id=$1", [w.west]);
    await q("update public.member_cases set step='Step 1' where id=$1", [west]);
    expect(await caseZone(west)).toBe(WEST);
    await q("update public.member_cases set deadline='2026-12-16' where id=$1", [west]);
    expect(await caseZone(west)).toBe("America/Chicago");
    // A step deadline takes its group's zone, whatever the writer sent, and a new moment takes it again.
    const step = await stepDeadline(west, w.west, "2026-12-01T12:00:00Z");
    expect(await stepZone(step)).toBe("America/Chicago");
    await q("update public.chapters set time_zone=null where id=$1", [w.west]);
    await q("update public.casework_deadlines set label='Fictional renamed' where id=$1", [step]);
    expect(await stepZone(step)).toBe("America/Chicago");
    await q("update public.casework_deadlines set due_at='2026-12-02T12:00:00Z' where id=$1", [step]);
    expect(await stepZone(step)).toBe(EAST);
  });

  it("keeps the zone a deadline was set in when the switch is released later", async () => {
    await release(false);
    const id = await caseFor(w.westMember, "2026-12-15");
    await release(true);
    await q("update public.member_cases set title='Fictional renamed' where id=$1", [id]);
    expect(await caseZone(id)).toBe("America/New_York");
  });

  it("answers a zone for any stored record without refusing", async () => {
    await release(true);
    const zone = (org, chapter) => one("select private.record_time_zone($1::uuid, $2::text) v", [org, chapter]);
    expect(await zone(w.org, null)).toBe(EAST);
    expect(await zone(w.org, w.west)).toBe(WEST);
    expect(await zone(null, w.west)).toBe(WEST);
    // A chapter outside the organization counts on the organization's zone; no organization on New York's.
    const other = randomUUID();
    await q("insert into public.organizations(id,slug,name,time_zone) values ($1::uuid,$1::text,'Fictional Other Local','Asia/Kolkata')", [other]);
    expect(await zone(other, w.west)).toBe("Asia/Kolkata");
    expect(await zone(null, null)).toBe("America/New_York");
    expect(await zone(randomUUID(), w.west)).toBe("America/New_York");
  });

  it("counts each case's deadline notices on its own zone", async () => {
    await release(true);
    const westToday = await today(WEST);
    // West's today is already past in the east, so only the west case is due.
    const west = await caseFor(w.westMember, westToday, w.steward);
    const east = await caseFor(w.eastMember, westToday, w.steward);
    await q("select private.case_deadline_notice_sweep()");
    const stamps = (await q("select id, deadline_notice_1_sent_at is not null as today from public.member_cases where id = any($1::uuid[])", [[west, east]])).rows;
    expect(Object.fromEntries(stamps.map((row) => [row.id, row.today]))).toEqual({ [west]: true, [east]: false });
    expect(await one("select count(*)::int v from public.member_notifications where user_id=$1 and kind='deadlines'", [w.westMember])).toBeGreaterThan(0);
    expect(await one("select count(*)::int v from public.member_notifications where user_id=$1 and kind='deadlines'", [w.eastMember])).toBe(0);
    // The staff notice is keyed on the same day, at the same stage.
    const marks = (await q("select deadline_id, due_on::text, stage from private.staff_deadline_notice_marks where deadline_id = any($1::uuid[])", [[west, east]])).rows;
    expect(marks).toEqual([{ deadline_id: west, due_on: westToday, stage: 3 }]);
  });

  it("keys a step deadline's staff notice on its day in its own zone", async () => {
    await release(true);
    const west = await caseFor(w.westMember, null, w.steward);
    const step = await stepDeadline(west, w.west, (await one("select (now() + interval '1 hour')::text v")));
    await q("select private.staff_deadline_notice_sweep()");
    const [mark] = (await q("select due_on::text, stage from private.staff_deadline_notice_marks where deadline_id=$1", [step])).rows;
    const expected = await one("select private.local_day($1, d.due_at)::text v from public.casework_deadlines d where d.id=$2", [WEST, step]);
    expect(mark.due_on).toBe(expected);
    expect(mark.stage).toBe(expected === (await today(WEST)) ? 3 : 2);
    // The case's next deadline is the same day, counted on the same zone.
    expect(await one("select n.due_on::text v from private.case_next_deadline($1, null, $2) n", [west, WEST])).toBe(expected);
  });
});
