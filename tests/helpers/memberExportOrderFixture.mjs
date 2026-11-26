import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertDisposableProofUrl } from "../../scripts/run-required-db-proofs.mjs";

export async function withMemberExportOrderFixture(run) {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "member-export-order-proof" });
  await db.connect();
  await db.query("begin");
  try {
    await db.query("set local statement_timeout='60s'");
    await db.query("set local enable_indexscan=off; set local enable_bitmapscan=off; set local max_parallel_workers_per_gather=0");
    const ids = { org: randomUUID(), member: randomUUID(), steward: randomUUID(), session: randomUUID() };
    ids.chapter = `export-order-${ids.org}`;
    const tied = "2026-11-01T12:00:00.000Z";
    const owner = async () => {
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims','',true)");
    };
    const person = async (id, org, chapter) => {
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name='Fictional export member' where id=$1", [id, chapter]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
    };
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional export organization')", [ids.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9960)", [ids.chapter, ids.org]);
    await person(ids.member, ids.org, ids.chapter);
    await person(ids.steward, ids.org, ids.chapter);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [ids.session, ids.member]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), ids.member]);
    const appointments = [randomUUID(), randomUUID(), randomUUID()].sort();
    const notices = [randomUUID(), randomUUID(), randomUUID()].sort();
    const engagement = ["a-first", "m-middle", "z-last"];
    const rows = async (org, chapter, member, steward, appointmentIds, notificationIds, sources) => {
      // Consistent synthetic records, deliberately inserted opposite their
      // unique key order. Only fixture writes bypass unrelated writer hooks.
      await db.query("set local session_replication_role=replica");
      try {
        for (const [index, id] of [...appointmentIds].reverse().entries()) {
          await db.query(`insert into public.member_appointments(id,user_id,steward_id,chapter_id,appointment_type,duration_minutes,starts_at,ends_at,status,routed_via,created_at,updated_at)
            values($1,$2,$3,$4,'office_hours',30,$5::timestamptz + $6::int * interval '1 day',$5::timestamptz + $6::int * interval '1 day' + interval '30 minutes','confirmed','steward',$5,$5)`, [id, member, steward, chapter, tied, index]);
        }
        for (const id of [...notificationIds].reverse()) await db.query("insert into public.member_notifications(id,user_id,title,body,kind,created_at) values($1,$2,'Fictional notice','Fictional body','cases',$3)", [id, member, tied]);
        for (const source of [...sources].reverse()) await db.query("insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at) values($1,$2,$3,'qa_contribution',$4,$5)", [org, member, chapter, source, tied]);
      } finally { await db.query("set local session_replication_role=origin"); }
    };
    await rows(ids.org, ids.chapter, ids.member, ids.steward, appointments, notices, engagement);
    const exportOwn = async () => {
      await owner();
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids.member, session_id: ids.session, role: "authenticated", aal: "aal2" })]);
      await db.query("set local role authenticated");
      await db.query("savepoint export_read");
      try {
        return (await db.query("select public.get_member_data_export() value")).rows[0].value;
      } finally {
        await db.query("rollback to savepoint export_read; release savepoint export_read");
      }
    };
    const foreign = async () => {
      await owner();
      const org = randomUUID(), member = randomUUID(), steward = randomUUID();
      const chapter = `export-order-foreign-${org}`;
      await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional foreign export organization')", [org]);
      await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9961)", [chapter, org]);
      await person(member, org, chapter);
      await person(steward, org, chapter);
      await rows(org, chapter, member, steward, [randomUUID(),randomUUID(),randomUUID()], [randomUUID()], ["foreign-a","foreign-z"]);
      await db.query("analyze public.member_appointments; analyze public.organization_engagement_events; analyze public.member_notifications");
    };
    await run({ db, ids, tied, appointments, notices, engagement, owner, exportOwn, foreign });
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}
