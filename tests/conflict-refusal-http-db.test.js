// @vitest-environment node
// BUG-UG-STALE-EVENT-SAVE-LOCK-TIMEOUT-20261106 (#7202). SQLSTATE
// 40001 makes PostgREST 14 retry the transaction without limit, so a stale
// RSVP switch on SAMPLE spun for about 30 s and ended in HTTP 500 / 55P03.
// Migration 20261106220000 moves every business refusal to PT409. This proof
// runs the real Auth and PostgREST of an owned full replay: a stale switch and
// a stale agenda save come back at once as HTTP 409 with the event_changed
// detail and write nothing, and no function but the kept four still raises
// 40001. Run with SUPABASE_DB_URL and PRIVATE_FILE_STORAGE_STATUS_FILE.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl, assertDisposableStorageStatus } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.SUPABASE_DB_URL ? it : it.skip;

// A retry is the remedy for these, or PostgREST cannot reach them (it runs
// read committed); the migration's header says why for each.
const KEPT_40001 = [
  "private.lock_case_graph_read()",
  "private.lock_member_message_conversation(uuid)",
  "private.lock_message_lifecycle()",
  "public.submit_workload_log",
];

// The hosted apply runner strips the
// migration's own begin/commit and runs it after `set local search_path=''`
// (scripts/hosted-migration-apply-runner.mjs, migration bodies and wrapper()),
// so every type, table and function the statements name must be qualified.
databaseIt("applies under the hosted apply runner's empty search_path", async () => {
  const source = readFileSync(new URL("../supabase/migrations/20261106220000_conflict_refusals_not_retried.sql", import.meta.url), "utf8");
  const body = source.replace(/^begin;\s*$/im, "").replace(/^commit;\s*$/im, "");
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await db.connect();
  try {
    await db.query(`begin isolation level read committed;\nset local search_path='';set local lock_timeout='5s';set local statement_timeout='60s';\n${body}\nrollback;`);
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}, 120000);

databaseIt("leaves 40001 only where a retry is the remedy", async () => {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await db.connect();
  try {
    const { rows } = await db.query(`
      select n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as sig
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosrc ~* $re$errcode\\s*=\\s*'40001'$re$
      order by 1`);
    const left = rows.map((row) => row.sig.replace(/\s+/g, ""))
      .filter((sig) => !KEPT_40001.some((kept) => kept.endsWith(")") ? sig === kept : sig.startsWith(`${kept}(`)));
    expect(left).toEqual([]);
    const moved = (await db.query(`
      select pg_catalog.count(*)::int as n from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosrc ~* $re$errcode\\s*=\\s*'PT409'$re$`)).rows[0].n;
    // 56 moved by 20261106220000 and the three learning-content editors 20260929060000 moved.
    expect(moved).toBeGreaterThanOrEqual(59);
  } finally {
    await db.end();
  }
});

databaseIt("refuses a stale RSVP switch and agenda save at once with HTTP 409 event_changed and writes nothing", async () => {
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = assertDisposableStorageStatus(
    JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8")), connectionString,
  );
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
  const caller = createClient(status.API_URL, status.ANON_KEY, options);
  const db = new pg.Client({ connectionString });
  const org = randomUUID();
  const chapter = `stale-event-http-${org}`;
  const eventId = `stale-event-${randomUUID().slice(0, 12)}`;
  let userId;
  await db.connect();
  try {
    await db.query("set lock_timeout='5s'; set statement_timeout='15s'");
    const email = `${chapter}@example.invalid`, password = `Synthetic!${randomUUID()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    const session = await caller.auth.signInWithPassword({ email, password });
    if (session.error) throw session.error;
    // Committed fixtures: HTTP requests use their own connections.
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, userId]);
    // This synthetic organization permits its password session; the events
    // suite covers authorization, this proof covers the HTTP refusal.
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, userId]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [org, userId]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9951)", [chapter, org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [userId, chapter]);
    await db.query(`insert into public.member_events(id,title,starts_at,location,summary,order_index,chapter_id,rsvp_open,version)
      values($1,'Fictional chapter meeting',now() + interval '3 days','Hall B','A fictional meeting',9951,$2,false,2)`, [eventId, chapter]);

    const rpc = async (name, args) => {
      const started = Date.now();
      const response = await fetch(`${status.API_URL}/rest/v1/rpc/${name}`, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { apikey: status.ANON_KEY, authorization: `Bearer ${session.data.session.access_token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      return { status: response.status, body: await response.json(), ms: Date.now() - started };
    };
    const event = async () => (await db.query("select rsvp_open, agenda, version from public.member_events where id=$1", [eventId])).rows[0];
    const audits = async () => Number((await db.query("select count(*) from public.member_admin_audit where detail->>'eventId' = $1", [eventId])).rows[0].count);

    for (const [name, args] of [
      ["set_member_event_rsvp_open", { p_id: eventId, p_open: true, p_expected_version: 1 }],
      ["set_member_event_agenda", { p_id: eventId, p_agenda: "1. Stale agenda", p_expected_version: 1 }],
    ]) {
      const stale = await rpc(name, args);
      expect(stale.status, JSON.stringify(stale.body)).toBe(409);
      expect(stale.body).toMatchObject({ code: "PT409", details: "event_changed", message: "this event changed; reload it before saving" });
      expect(stale.ms, name).toBeLessThan(2000);
    }
    expect(await event()).toEqual({ rsvp_open: false, agenda: null, version: 2 });
    expect(await audits()).toBe(0);

    // The current version still saves, so the refusal is the version check.
    const fresh = await rpc("set_member_event_rsvp_open", { p_id: eventId, p_open: true, p_expected_version: 2 });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body).toMatchObject({ updated: true, rsvpOpen: true, version: 3 });
  } finally {
    // This test's random fixtures on a guarded disposable stack only.
    const failures = [];
    const clean = async (operation) => { try { await operation(); } catch (error) { failures.push(error); } };
    await clean(() => db.query("delete from public.member_admin_audit where detail->>'eventId' = $1", [eventId]));
    await clean(() => db.query("delete from public.member_events where id=$1 and chapter_id=$2", [eventId, chapter]));
    await clean(() => db.query("delete from public.member_roles where user_id=$1 and chapter_id=$2", [userId, chapter]));
    await clean(() => db.query("update public.member_profiles set chapter_id=null where id=$1 and chapter_id=$2", [userId, chapter]));
    await clean(() => db.query("delete from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [userId, chapter]));
    await clean(() => db.query("delete from public.chapters where id=$1 and organization_id=$2", [chapter, org]));
    await clean(() => db.query("delete from public.organization_role_grants where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.organization_memberships where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.dues_member_subjects where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.org_security_policy where organization_id=$1", [org]));
    await clean(() => db.query("delete from public.organizations where id=$1", [org]));
    if (userId) await clean(async () => { const removed = await admin.auth.admin.deleteUser(userId); if (removed.error) throw removed.error; });
    await db.end();
    if (failures.length) throw new AggregateError(failures, "stale event HTTP proof cleanup failed");
  }
});
